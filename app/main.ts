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

// In-memory storage for key-value pairs with expiry
interface StoredValue {
  value: string;
  expiresAt?: number; // Timestamp in milliseconds when the key expires
}

const store = new Map<string, StoredValue>();

// In-memory storage for lists
const lists = new Map<string, string[]>();

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
        
        // Return the length of the list as a RESP integer
        connection.write(encodeInteger(list.length));
      }
    }
  });
});

server.listen(6379, "127.0.0.1");
