import * as net from "net";

// You can use print statements as follows for debugging, they'll be visible when running tests.
console.log("Logs from your program will appear here!");

// RESP Parser - parses Redis Protocol messages
function parseRESP(data: Buffer): string[] | null {
  const message = data.toString();
  
  // Check if it's an array (starts with *)
  if (!message.startsWith('*')) {
    return null;
  }
  
  const parts: string[] = [];
  const lines = message.split('\r\n');
  
  // First line: *<number of elements>
  const numElements = parseInt(lines[0].substring(1));
  
  let lineIndex = 1;
  for (let i = 0; i < numElements; i++) {
    // Each element is a bulk string: $<length>\r\n<data>
    if (lines[lineIndex].startsWith('$')) {
      const length = parseInt(lines[lineIndex].substring(1));
      lineIndex++;
      const value = lines[lineIndex];
      parts.push(value);
      lineIndex++;
    }
  }
  
  return parts;
}

// Encode a string as a RESP bulk string
function encodeBulkString(str: string | null): string {
  if (str === null) {
    return "$-1\r\n"; // Null bulk string
  }
  return `$${str.length}\r\n${str}\r\n`;
}

// Encode an integer as a RESP integer
function encodeInteger(num: number): string {
  return `:${num}\r\n`;
}

// Encode an array as a RESP array
function encodeArray(items: string[]): string {
  let result = `*${items.length}\r\n`;
  for (const item of items) {
    result += encodeBulkString(item);
  }
  return result;
}

// In-memory storage for key-value pairs with expiry
interface StoredValue {
  value: string;
  expiresAt?: number; // Timestamp in milliseconds when the key expires
}

const store = new Map<string, StoredValue>();

// In-memory storage for lists
const lists = new Map<string, string[]>();

// Blocked clients waiting for BLPOP
interface BlockedClient {
  socket: net.Socket;
  key: string;
  timestamp: number;
  timeoutId?: NodeJS.Timeout;  // Timer for non-zero timeouts
}
const blockedClients = new Map<string, BlockedClient[]>();

// Helper function to wake up blocked clients when elements are added
function wakeUpBlockedClients(key: string): void {
  const blocked = blockedClients.get(key);
  if (!blocked || blocked.length === 0) {
    return;
  }
  
  const list = lists.get(key);
  if (!list || list.length === 0) {
    return;
  }
  
  // Wake up clients in FIFO order while there are elements
  while (blocked.length > 0 && list.length > 0) {
    const client = blocked.shift()!;
    const element = list.shift()!;
    
    // Clear timeout if it exists
    if (client.timeoutId) {
      clearTimeout(client.timeoutId);
    }
    
    // Send response: [key, element]
    const response = encodeArray([key, element]);
    client.socket.write(response);
    
    // Clean up empty list
    if (list.length === 0) {
      lists.delete(key);
    }
  }
  
  // Clean up empty blocked clients array
  if (blocked.length === 0) {
    blockedClients.delete(key);
  }
}

const server: net.Server = net.createServer((connection: net.Socket) => {
  // Handle connection
  connection.on("data", (data: Buffer) => {
    const parsed = parseRESP(data);
    
    if (!parsed || parsed.length === 0) {
      return;
    }
    
    // Get command (case-insensitive)
    const command = parsed[0].toLowerCase();
    
    if (command === "ping") {
      connection.write("+PONG\r\n");
    } else if (command === "echo") {
      // ECHO requires one argument
      if (parsed.length >= 2) {
        const message = parsed[1];
        connection.write(encodeBulkString(message));
      }
    } else if (command === "set") {
      // SET requires two arguments: key and value
      // Optional: PX <milliseconds> or EX <seconds>
      if (parsed.length >= 3) {
        const key = parsed[1];
        const value = parsed[2];
        
        let expiresAt: number | undefined = undefined;
        
        // Parse optional arguments
        for (let i = 3; i < parsed.length; i += 2) {
          const option = parsed[i].toLowerCase();
          const optionValue = parsed[i + 1];
          
          if (option === "px" && optionValue) {
            // PX option: expiry in milliseconds
            const milliseconds = parseInt(optionValue);
            expiresAt = Date.now() + milliseconds;
          } else if (option === "ex" && optionValue) {
            // EX option: expiry in seconds
            const seconds = parseInt(optionValue);
            expiresAt = Date.now() + (seconds * 1000);
          }
        }
        
        store.set(key, { value, expiresAt });
        connection.write("+OK\r\n");
      }
    } else if (command === "get") {
      // GET requires one argument: key
      if (parsed.length >= 2) {
        const key = parsed[1];
        const storedValue = store.get(key);
        
        // Check if key exists and hasn't expired
        if (storedValue) {
          if (storedValue.expiresAt && Date.now() > storedValue.expiresAt) {
            // Key has expired, delete it and return null
            store.delete(key);
            connection.write(encodeBulkString(null));
          } else {
            // Key is valid, return the value
            connection.write(encodeBulkString(storedValue.value));
          }
        } else {
          // Key doesn't exist
          connection.write(encodeBulkString(null));
        }
      }
    } else if (command === "rpush") {
      // RPUSH requires at least two arguments: key and one or more values
      if (parsed.length >= 3) {
        const key = parsed[1];
        const values = parsed.slice(2); // All values after the key
        
        // Get or create the list
        let list = lists.get(key);
        if (!list) {
          list = [];
          lists.set(key, list);
        }
        
        // Push all values to the right (end) of the list
        list.push(...values);
        
        // Capture the length BEFORE waking up blocked clients
        const lengthAfterPush = list.length;
        
        // Wake up any blocked clients waiting for this list
        wakeUpBlockedClients(key);
        
        // Return the length of the list after push (before clients consumed elements)
        connection.write(encodeInteger(lengthAfterPush));
      }
    } else if (command === "lpush") {
      // LPUSH requires at least two arguments: key and one or more values
      if (parsed.length >= 3) {
        const key = parsed[1];
        const values = parsed.slice(2); // All values after the key
        
        // Get or create the list
        let list = lists.get(key);
        if (!list) {
          list = [];
          lists.set(key, list);
        }
        
        // Push all values to the left (start) of the list
        // Elements are prepended in order, so they appear in reverse
        for (const value of values) {
          list.unshift(value);
        }
        
        // Capture the length BEFORE waking up blocked clients
        const lengthAfterPush = list.length;
        
        // Wake up any blocked clients waiting for this list
        wakeUpBlockedClients(key);
        
        // Return the length of the list after push (before clients consumed elements)
        connection.write(encodeInteger(lengthAfterPush));
      }
    } else if (command === "llen") {
      // LLEN requires one argument: key
      if (parsed.length >= 2) {
        const key = parsed[1];
        const list = lists.get(key);
        
        // If list doesn't exist, return 0
        if (!list) {
          connection.write(encodeInteger(0));
        } else {
          // Return the length of the list as a RESP integer
          connection.write(encodeInteger(list.length));
        }
      }
    } else if (command === "lpop") {
      // LPOP requires one argument: key
      // Optional second argument: count (number of elements to remove)
      if (parsed.length >= 2) {
        const key = parsed[1];
        const list = lists.get(key);
        
        // Check if count argument is provided
        const count = parsed.length >= 3 ? parseInt(parsed[2]) : 1;
        
        // If list doesn't exist or is empty, return null bulk string
        if (!list || list.length === 0) {
          connection.write(encodeBulkString(null));
        } else if (count === 1) {
          // Single element: return as bulk string (backward compatibility)
          const element = list.shift();
          connection.write(encodeBulkString(element!));
          
          // Clean up empty list
          if (list.length === 0) {
            lists.delete(key);
          }
        } else {
          // Multiple elements: return as array
          const numToRemove = Math.min(count, list.length);
          const removed: string[] = [];
          
          // Remove elements from the start
          for (let i = 0; i < numToRemove; i++) {
            const element = list.shift();
            if (element !== undefined) {
              removed.push(element);
            }
          }
          
          // Return as RESP array
          connection.write(encodeArray(removed));
          
          // Clean up empty list
          if (list.length === 0) {
            lists.delete(key);
          }
        }
      }
    } else if (command === "blpop") {
      // BLPOP requires two arguments: key and timeout
      if (parsed.length >= 3) {
        const key = parsed[1];
        const timeoutSeconds = parseFloat(parsed[2]); // Can be decimal (0.5 = 500ms)
        
        const list = lists.get(key);
        
        // If list has elements, pop immediately
        if (list && list.length > 0) {
          const element = list.shift()!;
          
          // Return [key, element] as RESP array
          connection.write(encodeArray([key, element]));
          
          // Clean up empty list
          if (list.length === 0) {
            lists.delete(key);
          }
        } else {
          // No elements available, block the client
          let blocked = blockedClients.get(key);
          if (!blocked) {
            blocked = [];
            blockedClients.set(key, blocked);
          }
          
          // Create blocked client entry
          const blockedClient: BlockedClient = {
            socket: connection,
            key: key,
            timestamp: Date.now()
          };
          
          // Set up timeout if non-zero
          if (timeoutSeconds > 0) {
            const timeoutMs = timeoutSeconds * 1000;
            const timeoutId = setTimeout(() => {
              // Find and remove this client from blocked queue
              const blocked = blockedClients.get(key);
              if (blocked) {
                const index = blocked.indexOf(blockedClient);
                if (index !== -1) {
                  blocked.splice(index, 1);
                  
                  // Clean up empty blocked clients array
                  if (blocked.length === 0) {
                    blockedClients.delete(key);
                  }
                }
              }
              
              // Send null array response
              connection.write("*-1\r\n");
            }, timeoutMs);
            
            blockedClient.timeoutId = timeoutId;
          }
          
          // Add client to blocked queue
          blocked.push(blockedClient);
          
          // Don't send response yet - will be sent when element is added or timeout expires
        }
      }
    } else if (command === "lrange") {
      // LRANGE requires three arguments: key, start, stop
      if (parsed.length >= 4) {
        const key = parsed[1];
        let start = parseInt(parsed[2]);
        let stop = parseInt(parsed[3]);
        
        // Get the list
        const list = lists.get(key);
        
        // If list doesn't exist, return empty array
        if (!list) {
          connection.write("*0\r\n");
          return;
        }
        
        // Handle negative indexes
        // Negative indexes count from the end: -1 is last element, -2 is second-to-last, etc.
        if (start < 0) {
          start = list.length + start;
          // If still negative (out of range), treat as 0
          if (start < 0) {
            start = 0;
          }
        }
        
        if (stop < 0) {
          stop = list.length + stop;
          // If still negative (out of range), treat as 0
          if (stop < 0) {
            stop = 0;
          }
        }
        
        // If start >= list length, return empty array
        if (start >= list.length) {
          connection.write("*0\r\n");
          return;
        }
        
        // If start > stop, return empty array
        if (start > stop) {
          connection.write("*0\r\n");
          return;
        }
        
        // Calculate actual stop index (inclusive, but limited to list length)
        const actualStop = Math.min(stop, list.length - 1);
        
        // Extract the range (stop is inclusive, so we need actualStop + 1 for slice)
        const range = list.slice(start, actualStop + 1);
        
        // Return the range as a RESP array
        connection.write(encodeArray(range));
      }
    }
  });
});

server.listen(6379, "127.0.0.1");
