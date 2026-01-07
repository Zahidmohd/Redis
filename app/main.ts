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

// In-memory storage for key-value pairs
const store = new Map<string, string>();

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
      if (parsed.length >= 3) {
        const key = parsed[1];
        const value = parsed[2];
        store.set(key, value);
        connection.write("+OK\r\n");
      }
    } else if (command === "get") {
      // GET requires one argument: key
      if (parsed.length >= 2) {
        const key = parsed[1];
        const value = store.get(key);
        connection.write(encodeBulkString(value ?? null));
      }
    }
  });
});

server.listen(6379, "127.0.0.1");
