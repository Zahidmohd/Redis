import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

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

// RESP3 encoding functions
function encodeRESP3Null(): string {
  return "_\r\n";
}

function encodeRESP3Boolean(value: boolean): string {
  return value ? "#t\r\n" : "#f\r\n";
}

function encodeRESP3Double(num: number): string {
  return `,${num}\r\n`;
}

function encodeRESP3Map(map: Map<string, string>): string {
  let result = `%${map.size}\r\n`;
  for (const [key, value] of map) {
    result += encodeBulkString(key);
    result += encodeBulkString(value);
  }
  return result;
}

function encodeRESP3Set(items: string[]): string {
  let result = `~${items.length}\r\n`;
  for (const item of items) {
    result += encodeBulkString(item);
  }
  return result;
}

// Helper to encode null based on protocol version
function encodeNull(connection: net.Socket): string {
  const version = protocolVersion.get(connection) || 2;
  return version === 3 ? encodeRESP3Null() : encodeBulkString(null);
}

// Bloom Filter implementation
class BloomFilter {
  private bitArray: Uint8Array;
  private capacity: number;
  private errorRate: number;
  private numBits: number;
  private numHashes: number;
  private itemCount: number;

  constructor(capacity: number = 100, errorRate: number = 0.01) {
    this.capacity = capacity;
    this.errorRate = errorRate;
    this.itemCount = 0;

    // Calculate optimal number of bits: m = -(n * ln(p)) / (ln(2)^2)
    // where n = capacity, p = error rate
    this.numBits = Math.ceil(-(capacity * Math.log(errorRate)) / (Math.log(2) ** 2));
    
    // Calculate optimal number of hash functions: k = (m/n) * ln(2)
    this.numHashes = Math.ceil((this.numBits / capacity) * Math.log(2));
    
    // Create bit array (divide by 8 to get bytes)
    const numBytes = Math.ceil(this.numBits / 8);
    this.bitArray = new Uint8Array(numBytes);
  }

  // Hash function using FNV-1a algorithm
  private hash(item: string, seed: number): number {
    let hash = 2166136261 ^ seed; // FNV offset basis XOR with seed
    for (let i = 0; i < item.length; i++) {
      hash ^= item.charCodeAt(i);
      hash = Math.imul(hash, 16777619); // FNV prime
    }
    return (hash >>> 0) % this.numBits; // Ensure positive and within range
  }

  // Add an item to the bloom filter
  add(item: string): boolean {
    let wasAlreadyPresent = true;
    
    for (let i = 0; i < this.numHashes; i++) {
      const bitIndex = this.hash(item, i);
      const byteIndex = Math.floor(bitIndex / 8);
      const bitOffset = bitIndex % 8;
      
      const mask = 1 << bitOffset;
      
      // Check if bit was already set
      if ((this.bitArray[byteIndex] & mask) === 0) {
        wasAlreadyPresent = false;
        this.bitArray[byteIndex] |= mask;
      }
    }
    
    // Only increment count if item wasn't already present
    if (!wasAlreadyPresent) {
      this.itemCount++;
    }
    
    return !wasAlreadyPresent; // Return true if newly added
  }

  // Check if an item exists in the bloom filter
  exists(item: string): boolean {
    for (let i = 0; i < this.numHashes; i++) {
      const bitIndex = this.hash(item, i);
      const byteIndex = Math.floor(bitIndex / 8);
      const bitOffset = bitIndex % 8;
      
      const mask = 1 << bitOffset;
      
      // If any bit is not set, item definitely doesn't exist
      if ((this.bitArray[byteIndex] & mask) === 0) {
        return false;
      }
    }
    
    // All bits are set, item might exist (could be false positive)
    return true;
  }

  // Get info about the bloom filter
  getInfo(): { capacity: number; size: number; numFilters: number; numItemsInserted: number; expansionRate: number } {
    return {
      capacity: this.capacity,
      size: this.numBits,
      numFilters: 1,
      numItemsInserted: this.itemCount,
      expansionRate: 2
    };
  }
}

// Helper function to parse stream entry ID (handles optional sequence number)
function parseStreamId(id: string, defaultSeq: number): { msTime: number; seqNum: number } {
  const parts = id.split('-');
  const msTime = parseInt(parts[0]);
  const seqNum = parts.length > 1 && parts[1] !== '' ? parseInt(parts[1]) : defaultSeq;
  return { msTime, seqNum };
}

// Helper function to compare stream entry IDs
function compareStreamIds(id1: { msTime: number; seqNum: number }, id2: { msTime: number; seqNum: number }): number {
  if (id1.msTime !== id2.msTime) {
    return id1.msTime - id2.msTime;
  }
  return id1.seqNum - id2.seqNum;
}

// Helper function to spread 32-bit integer to 64-bit with interleaved zeros
function spread32BitsTo64Bits(v: number): bigint {
  let result = BigInt(v) & 0xFFFFFFFFn;
  result = (result | (result << 16n)) & 0x0000FFFF0000FFFFn;
  result = (result | (result << 8n)) & 0x00FF00FF00FF00FFn;
  result = (result | (result << 4n)) & 0x0F0F0F0F0F0F0F0Fn;
  result = (result | (result << 2n)) & 0x3333333333333333n;
  result = (result | (result << 1n)) & 0x5555555555555555n;
  return result;
}

// Helper function to interleave bits of x and y
function interleaveBits(x: number, y: number): bigint {
  const xSpread = spread32BitsTo64Bits(x);
  const ySpread = spread32BitsTo64Bits(y);
  const yShifted = ySpread << 1n;
  return xSpread | yShifted;
}

// Helper function to encode geohash from longitude and latitude
function encodeGeohash(longitude: number, latitude: number): number {
  // Constants from Redis geohash implementation
  const ENCODE_MIN_LATITUDE = -85.05112878;
  const ENCODE_MAX_LATITUDE = 85.05112878;
  const ENCODE_MIN_LONGITUDE = -180.0;
  const ENCODE_MAX_LONGITUDE = 180.0;
  
  const ENCODE_LATITUDE_RANGE = ENCODE_MAX_LATITUDE - ENCODE_MIN_LATITUDE;
  const ENCODE_LONGITUDE_RANGE = ENCODE_MAX_LONGITUDE - ENCODE_MIN_LONGITUDE;
  
  // Normalize to the range 0-2^26
  const normalizedLatitude = Math.pow(2, 26) * (latitude - ENCODE_MIN_LATITUDE) / ENCODE_LATITUDE_RANGE;
  const normalizedLongitude = Math.pow(2, 26) * (longitude - ENCODE_MIN_LONGITUDE) / ENCODE_LONGITUDE_RANGE;
  
  // Truncate to integers
  const latInt = Math.floor(normalizedLatitude);
  const lonInt = Math.floor(normalizedLongitude);
  
  // Interleave bits and return as number
  const geohashBigInt = interleaveBits(latInt, lonInt);
  return Number(geohashBigInt);
}

// Helper function to compact 64-bit with interleaved bits back to 32-bit
function decodeCompactInt64ToInt32(v: bigint): number {
  v = v & 0x5555555555555555n;
  v = (v | (v >> 1n)) & 0x3333333333333333n;
  v = (v | (v >> 2n)) & 0x0F0F0F0F0F0F0F0Fn;
  v = (v | (v >> 4n)) & 0x00FF00FF00FF00FFn;
  v = (v | (v >> 8n)) & 0x0000FFFF0000FFFFn;
  v = (v | (v >> 16n)) & 0x00000000FFFFFFFFn;
  return Number(v);
}

// Helper function to decode geohash back to longitude and latitude
function decodeGeohash(geohash: number): { longitude: number, latitude: number } {
  // Constants from Redis geohash implementation
  const DECODE_MIN_LATITUDE = -85.05112878;
  const DECODE_MAX_LATITUDE = 85.05112878;
  const DECODE_MIN_LONGITUDE = -180.0;
  const DECODE_MAX_LONGITUDE = 180.0;
  
  const DECODE_LATITUDE_RANGE = DECODE_MAX_LATITUDE - DECODE_MIN_LATITUDE;
  const DECODE_LONGITUDE_RANGE = DECODE_MAX_LONGITUDE - DECODE_MIN_LONGITUDE;
  
  const geoCode = BigInt(geohash);
  
  // Align bits of both latitude and longitude to take even-numbered position
  const y = geoCode >> 1n;
  const x = geoCode;
  
  // Compact bits back to 32-bit ints
  const gridLatitudeNumber = decodeCompactInt64ToInt32(x);
  const gridLongitudeNumber = decodeCompactInt64ToInt32(y);
  
  // Calculate the grid boundaries
  const gridLatitudeMin = DECODE_MIN_LATITUDE + DECODE_LATITUDE_RANGE * (gridLatitudeNumber * 1.0 / Math.pow(2, 26));
  const gridLatitudeMax = DECODE_MIN_LATITUDE + DECODE_LATITUDE_RANGE * ((gridLatitudeNumber + 1) * 1.0 / Math.pow(2, 26));
  const gridLongitudeMin = DECODE_MIN_LONGITUDE + DECODE_LONGITUDE_RANGE * (gridLongitudeNumber * 1.0 / Math.pow(2, 26));
  const gridLongitudeMax = DECODE_MIN_LONGITUDE + DECODE_LONGITUDE_RANGE * ((gridLongitudeNumber + 1) * 1.0 / Math.pow(2, 26));
  
  // Calculate the center point of the grid cell
  const latitude = (gridLatitudeMin + gridLatitudeMax) / 2;
  const longitude = (gridLongitudeMin + gridLongitudeMax) / 2;
  
  return { longitude, latitude };
}

// Helper function to calculate distance between two coordinates using Haversine formula
function calculateDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  // Earth's radius in meters (as used by Redis)
  const EARTH_RADIUS = 6372797.560856;
  
  // Convert degrees to radians
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  
  const φ1 = toRadians(lat1);
  const φ2 = toRadians(lat2);
  const Δφ = toRadians(lat2 - lat1);
  const Δλ = toRadians(lon2 - lon1);
  
  // Haversine formula
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  const distance = EARTH_RADIUS * c;
  
  return distance;
}

// In-memory storage for key-value pairs with expiry
interface StoredValue {
  value: string;
  expiresAt?: number; // Timestamp in milliseconds when the key expires
}

const store = new Map<string, StoredValue>();

// In-memory storage for lists
const lists = new Map<string, string[]>();

// In-memory storage for streams
interface StreamEntry {
  id: string;
  fields: Map<string, string>;
}
const streams = new Map<string, StreamEntry[]>();

// Blocked clients waiting for BLPOP
interface BlockedClient {
  socket: net.Socket;
  key: string;
  timestamp: number;
  timeoutId?: NodeJS.Timeout;  // Timer for non-zero timeouts
}
const blockedClients = new Map<string, BlockedClient[]>();

// Blocked clients waiting for XREAD
interface BlockedXReadClient {
  socket: net.Socket;
  streamKeys: string[];
  afterIds: string[];
  timestamp: number;
  timeoutId?: NodeJS.Timeout;
}
const blockedXReadClients: BlockedXReadClient[] = [];

// Pub/Sub: Track channel subscriptions per client
const subscriptions = new Map<net.Socket, Set<string>>();

// Sorted sets storage
interface SortedSetMember {
  member: string;
  score: number;
}
const sortedSets = new Map<string, SortedSetMember[]>();

// Sets storage (unordered collection of unique strings)
const sets = new Map<string, Set<string>>();

// Bloom filters storage
const bloomFilters = new Map<string, BloomFilter>();

// ACL user storage
interface User {
  flags: string[];
  passwords: string[];  // SHA-256 hashes
}
const users = new Map<string, User>();

// Initialize default user with nopass flag
users.set("default", {
  flags: ["nopass"],
  passwords: []
});

// Transaction state per connection
const transactionState = new Map<net.Socket, boolean>();
// Queued commands per connection
const queuedCommands = new Map<net.Socket, string[][]>();

// Optimistic locking: Track watched keys per connection
const watchedKeys = new Map<net.Socket, Set<string>>();
// Track snapshot of key versions when MULTI is called (for each connection)
const watchedKeyVersions = new Map<net.Socket, Map<string, number>>();
// Track version number for each key (incremented on every modification)
const keyVersions = new Map<string, number>();

// Authenticated user per connection (null = not authenticated)
const authenticatedUser = new Map<net.Socket, string | null>();

// Protocol version per connection (2 = RESP2, 3 = RESP3)
const protocolVersion = new Map<net.Socket, number>();

// Parse command-line arguments
let serverPort = 6379; // Default port
let serverRole = "master"; // Default role
let masterHost: string | null = null;
let masterPort: number | null = null;

// RDB configuration
let configDir = "/tmp/redis-data"; // Default directory
let configDbfilename = "dump.rdb"; // Default filename

// AOF configuration
let appendonly = false; // AOF disabled by default
let appendfilename = "appendonly.aof"; // Default AOF filename
let appendfsync: "always" | "everysec" | "no" = "everysec"; // Sync policy
let aofFileDescriptor: number | null = null; // File descriptor for AOF file
let aofBuffer: string[] = []; // Buffer for AOF writes
let lastAOFSync = Date.now(); // Last time AOF was synced

const cmdArgs = process.argv.slice(2); // Skip 'node' and script name
for (let i = 0; i < cmdArgs.length; i++) {
  if (cmdArgs[i] === '--port' && i + 1 < cmdArgs.length) {
    serverPort = parseInt(cmdArgs[i + 1]);
  } else if (cmdArgs[i] === '--replicaof' && i + 1 < cmdArgs.length) {
    serverRole = "slave";
    // Parse "host port" from the argument
    const replicaofValue = cmdArgs[i + 1];
    const parts = replicaofValue.split(' ');
    if (parts.length === 2) {
      masterHost = parts[0];
      masterPort = parseInt(parts[1]);
    }
  } else if (cmdArgs[i] === '--dir' && i + 1 < cmdArgs.length) {
    configDir = cmdArgs[i + 1];
  } else if (cmdArgs[i] === '--dbfilename' && i + 1 < cmdArgs.length) {
    configDbfilename = cmdArgs[i + 1];
  }
}

// Helper function to read length-encoded integer from RDB
function readLength(buffer: Buffer, offset: number): { value: number, bytesRead: number, isSpecial: boolean } {
  const firstByte = buffer[offset];
  const type = (firstByte & 0xC0) >> 6; // First 2 bits
  
  if (type === 0b00) {
    // 6-bit length
    return { value: firstByte & 0x3F, bytesRead: 1, isSpecial: false };
  } else if (type === 0b01) {
    // 14-bit length
    const nextByte = buffer[offset + 1];
    const length = ((firstByte & 0x3F) << 8) | nextByte;
    return { value: length, bytesRead: 2, isSpecial: false };
  } else if (type === 0b10) {
    // 32-bit length (big-endian)
    const length = buffer.readUInt32BE(offset + 1);
    return { value: length, bytesRead: 5, isSpecial: false };
  } else {
    // Special format (type === 0b11)
    const specialType = firstByte & 0x3F;
    return { value: specialType, bytesRead: 1, isSpecial: true };
  }
}

// Helper function to read a string from RDB
function readString(buffer: Buffer, offset: number): { value: string, bytesRead: number } {
  const lengthInfo = readLength(buffer, offset);
  let currentOffset = offset + lengthInfo.bytesRead;
  
  if (lengthInfo.isSpecial) {
    // Special encoding (integers as strings, compressed strings, etc.)
    const specialType = lengthInfo.value;
    
    if (specialType === 0) {
      // 8-bit integer
      const intValue = buffer.readInt8(currentOffset);
      return { value: intValue.toString(), bytesRead: lengthInfo.bytesRead + 1 };
    } else if (specialType === 1) {
      // 16-bit integer
      const intValue = buffer.readInt16LE(currentOffset);
      return { value: intValue.toString(), bytesRead: lengthInfo.bytesRead + 2 };
    } else if (specialType === 2) {
      // 32-bit integer
      const intValue = buffer.readInt32LE(currentOffset);
      return { value: intValue.toString(), bytesRead: lengthInfo.bytesRead + 4 };
    } else if (specialType === 3) {
      // Compressed string - not implemented
      throw new Error("Compressed strings not supported");
    }
  }
  
  // Regular string - length-prefixed
  const strValue = buffer.toString('utf8', currentOffset, currentOffset + lengthInfo.value);
  return { value: strValue, bytesRead: lengthInfo.bytesRead + lengthInfo.value };
}

// AOF Functions

// Append a command to the AOF file
function appendToAOF(commandArray: string[]): void {
  if (!appendonly) {
    return; // AOF is disabled
  }
  
  // Build RESP array for the command
  let resp = `*${commandArray.length}\r\n`;
  for (const arg of commandArray) {
    resp += `$${arg.length}\r\n${arg}\r\n`;
  }
  
  // Add to buffer
  aofBuffer.push(resp);
  
  // Handle different sync modes
  if (appendfsync === "always") {
    // Sync immediately
    flushAOF();
  } else if (appendfsync === "everysec") {
    // Sync every second (handled by interval timer)
    const now = Date.now();
    if (now - lastAOFSync >= 1000) {
      flushAOF();
    }
  }
  // "no" mode: let OS decide when to sync
}

// Flush AOF buffer to disk
function flushAOF(): void {
  if (aofBuffer.length === 0) {
    return;
  }
  
  try {
    // Open AOF file if not already open
    if (aofFileDescriptor === null) {
      const aofPath = `${configDir}/${appendfilename}`;
      // Create directory if it doesn't exist
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      // Open file in append mode
      aofFileDescriptor = fs.openSync(aofPath, 'a');
    }
    
    // Write all buffered commands
    const data = aofBuffer.join('');
    fs.writeSync(aofFileDescriptor, data);
    
    // Sync to disk
    fs.fsyncSync(aofFileDescriptor);
    
    // Clear buffer
    aofBuffer = [];
    lastAOFSync = Date.now();
  } catch (error) {
    console.error(`Error writing to AOF file: ${error}`);
  }
}

// Load and replay commands from AOF file
function loadAOF(): void {
  if (!appendonly) {
    return; // AOF is disabled
  }
  
  const aofPath = `${configDir}/${appendfilename}`;
  
  // Check if file exists
  if (!fs.existsSync(aofPath)) {
    console.log(`AOF file not found at ${aofPath}, starting with empty database`);
    return;
  }
  
  try {
    const data = fs.readFileSync(aofPath);
    console.log(`Loading AOF file from ${aofPath} (${data.length} bytes)`);
    
    let offset = 0;
    let commandsLoaded = 0;
    
    // Parse and replay commands
    while (offset < data.length) {
      const parsed = parseRESP(data.slice(offset));
      
      if (!parsed || parsed.length === 0) {
        break;
      }
      
      // Execute the command
      const command = parsed[0].toLowerCase();
      
      // Execute write commands
      if (command === "set" && parsed.length >= 3) {
        const key = parsed[1];
        const value = parsed[2];
        let expiresAt: number | undefined = undefined;
        
        for (let i = 3; i < parsed.length; i += 2) {
          const option = parsed[i]?.toLowerCase();
          const optionValue = parsed[i + 1];
          if (option === "px" && optionValue) {
            expiresAt = Date.now() + parseInt(optionValue);
          } else if (option === "ex" && optionValue) {
            expiresAt = Date.now() + parseInt(optionValue) * 1000;
          }
        }
        
        store.set(key, { value, expiresAt });
        incrementKeyVersion(key);
      } else if (command === "del" && parsed.length >= 2) {
        for (let i = 1; i < parsed.length; i++) {
          store.delete(parsed[i]);
          lists.delete(parsed[i]);
          streams.delete(parsed[i]);
          sortedSets.delete(parsed[i]);
          sets.delete(parsed[i]);
          bloomFilters.delete(parsed[i]);
          incrementKeyVersion(parsed[i]);
        }
      } else if (command === "sadd" && parsed.length >= 3) {
        const key = parsed[1];
        let set = sets.get(key);
        if (!set) {
          set = new Set<string>();
          sets.set(key, set);
        }
        for (let i = 2; i < parsed.length; i++) {
          set.add(parsed[i]);
        }
        incrementKeyVersion(key);
      } else if (command === "lpush" && parsed.length >= 3) {
        const key = parsed[1];
        let list = lists.get(key);
        if (!list) {
          list = [];
          lists.set(key, list);
        }
        for (let i = 2; i < parsed.length; i++) {
          list.unshift(parsed[i]);
        }
        incrementKeyVersion(key);
      } else if (command === "rpush" && parsed.length >= 3) {
        const key = parsed[1];
        let list = lists.get(key);
        if (!list) {
          list = [];
          lists.set(key, list);
        }
        for (let i = 2; i < parsed.length; i++) {
          list.push(parsed[i]);
        }
        incrementKeyVersion(key);
      }
      // Add more commands as needed
      
      commandsLoaded++;
      
      // Calculate bytes consumed to move offset
      const message = data.slice(offset).toString();
      const lines = message.split('\r\n');
      const numElements = parseInt(lines[0].substring(1));
      let consumed = lines[0].length + 2; // First line + \r\n
      
      for (let i = 0; i < numElements; i++) {
        const lineIdx = 1 + i * 2;
        if (lineIdx >= lines.length) break;
        const bulkLength = parseInt(lines[lineIdx].substring(1));
        consumed += lines[lineIdx].length + 2; // Length line + \r\n
        consumed += bulkLength + 2; // Data + \r\n
      }
      
      offset += consumed;
    }
    
    console.log(`Loaded ${commandsLoaded} commands from AOF file`);
  } catch (error) {
    console.error(`Error loading AOF file: ${error}`);
  }
}

// Set up AOF sync interval for "everysec" mode
if (appendonly && appendfsync === "everysec") {
  setInterval(() => {
    if (Date.now() - lastAOFSync >= 1000) {
      flushAOF();
    }
  }, 1000);
}

// Function to read RDB file and load data
function loadRDBFile() {
  const rdbPath = `${configDir}/${configDbfilename}`;
  
  // Check if file exists
  if (!fs.existsSync(rdbPath)) {
    console.log(`RDB file not found at ${rdbPath}, starting with empty database`);
    return;
  }
  
  try {
    const buffer = fs.readFileSync(rdbPath);
    console.log(`Loading RDB file from ${rdbPath} (${buffer.length} bytes)`);
    
    let offset = 0;
    
    // Check magic string "REDIS"
    const magic = buffer.toString('ascii', offset, offset + 5);
    if (magic !== 'REDIS') {
      console.log('Invalid RDB file: magic string mismatch');
      return;
    }
    offset += 5;
    
    // Read version (4 bytes)
    const version = buffer.toString('ascii', offset, offset + 4);
    console.log(`RDB version: ${version}`);
    offset += 4;
    
    // Parse the file
    while (offset < buffer.length) {
      const opcode = buffer[offset];
      offset++;
      
      if (opcode === 0xFF) {
        // EOF marker
        console.log('Reached EOF marker');
        break;
      } else if (opcode === 0xFE) {
        // Database selector
        const dbNumber = buffer[offset];
        offset++;
        console.log(`Database selector: ${dbNumber}`);
      } else if (opcode === 0xFB) {
        // Hash table size info
        const hashTableSize = buffer[offset];
        offset++;
        const expiryHashTableSize = buffer[offset];
        offset++;
        console.log(`Hash table size: ${hashTableSize}, expiry: ${expiryHashTableSize}`);
      } else if (opcode === 0xFA) {
        // Metadata
        const keyResult = readString(buffer, offset);
        const key = keyResult.value;
        offset += keyResult.bytesRead;
        
        const valueResult = readString(buffer, offset);
        const value = valueResult.value;
        offset += valueResult.bytesRead;
        console.log(`Metadata: ${key} = ${value}`);
      } else if (opcode === 0xFC) {
        // Expiry time in milliseconds (8 bytes)
        const expiryMs = buffer.readBigUInt64LE(offset);
        offset += 8;
        
        // Read value type
        const valueType = buffer[offset];
        offset++;
        
        // Read key
        const keyResult = readString(buffer, offset);
        const key = keyResult.value;
        offset += keyResult.bytesRead;
        
        // Read value (string)
        const valueResult = readString(buffer, offset);
        const value = valueResult.value;
        offset += valueResult.bytesRead;
        
        store.set(key, {
          value: value,
          expiresAt: Number(expiryMs)
        });
        console.log(`Loaded key with expiry: ${key} = ${value}, expires at ${expiryMs}`);
      } else if (opcode === 0xFD) {
        // Expiry time in seconds (4 bytes)
        const expirySec = buffer.readUInt32LE(offset);
        offset += 4;
        
        // Read value type
        const valueType = buffer[offset];
        offset++;
        
        // Read key
        const keyResult = readString(buffer, offset);
        const key = keyResult.value;
        offset += keyResult.bytesRead;
        
        // Read value (string)
        const valueResult = readString(buffer, offset);
        const value = valueResult.value;
        offset += valueResult.bytesRead;
        
        store.set(key, {
          value: value,
          expiresAt: expirySec * 1000
        });
        console.log(`Loaded key with expiry: ${key} = ${value}, expires at ${expirySec}s`);
      } else if (opcode === 0x00) {
        // String value (no expiry)
        // Read key
        const keyResult = readString(buffer, offset);
        const key = keyResult.value;
        offset += keyResult.bytesRead;
        
        // Read value
        const valueResult = readString(buffer, offset);
        const value = valueResult.value;
        offset += valueResult.bytesRead;
        
        store.set(key, { value: value });
        console.log(`Loaded key: ${key} = ${value}`);
      } else {
        console.log(`Unknown opcode: 0x${opcode.toString(16)}`);
        break;
      }
    }
    
    console.log(`Loaded ${store.size} keys from RDB file`);
  } catch (error) {
    console.log(`Error loading RDB file: ${error}`);
  }
}

// Load RDB file on startup (if AOF is disabled)
if (!appendonly) {
  loadRDBFile();
} else {
  // If AOF is enabled, load from AOF instead (it's more recent)
  loadAOF();
}

// Replication ID and offset (for master servers)
const masterReplId = "8371b4fb1155b71f4a04d3e1bc3e18c4a990aeeb";
let masterReplOffset = 0; // Changed to let so we can update it

// Track connected replicas
const replicas: net.Socket[] = [];

// Track each replica's acknowledged offset
const replicaOffsets = new Map<net.Socket, number>();

// Helper function to propagate commands to all replicas
function propagateToReplicas(commandArray: string[]): number {
  // Build RESP array for the command
  let resp = `*${commandArray.length}\r\n`;
  for (const arg of commandArray) {
    resp += `$${arg.length}\r\n${arg}\r\n`;
  }
  
  // Send to all connected replicas
  for (const replica of replicas) {
    replica.write(resp);
  }
  
  // Update master offset and return byte count
  const byteCount = resp.length;
  masterReplOffset += byteCount;
  
  return byteCount;
}

// Helper function to wake up blocked XREAD clients when entries are added to a stream
function wakeUpBlockedXReadClients(streamKey: string): void {
  // Check all blocked XREAD clients
  for (let i = blockedXReadClients.length - 1; i >= 0; i--) {
    const client = blockedXReadClients[i];
    
    // Check if this client is waiting for this stream
    const streamIndex = client.streamKeys.indexOf(streamKey);
    if (streamIndex === -1) {
      continue; // This client isn't waiting for this stream
    }
    
    // Check if there are new entries for this stream
    const stream = streams.get(streamKey);
    if (!stream || stream.length === 0) {
      continue;
    }
    
    const afterId = parseStreamId(client.afterIds[streamIndex], 0);
    let hasNewEntries = false;
    
    for (const entry of stream) {
      const entryId = parseStreamId(entry.id, 0);
      if (compareStreamIds(entryId, afterId) > 0) {
        hasNewEntries = true;
        break;
      }
    }
    
    if (!hasNewEntries) {
      continue;
    }
    
    // This client has new entries, wake it up
    // Clear timeout if it exists
    if (client.timeoutId) {
      clearTimeout(client.timeoutId);
    }
    
    // Build response for all streams this client is waiting for
    const streamResults: Array<{ key: string; entries: StreamEntry[] }> = [];
    
    for (let j = 0; j < client.streamKeys.length; j++) {
      const key = client.streamKeys[j];
      const afterIdStr = client.afterIds[j];
      const s = streams.get(key);
      
      if (!s) continue;
      
      const aid = parseStreamId(afterIdStr, 0);
      const results: StreamEntry[] = [];
      
      for (const entry of s) {
        const entryId = parseStreamId(entry.id, 0);
        if (compareStreamIds(entryId, aid) > 0) {
          results.push(entry);
        }
      }
      
      if (results.length > 0) {
        streamResults.push({ key, entries: results });
      }
    }
    
    // Build and send response
    let response = `*${streamResults.length}\r\n`;
    for (const streamResult of streamResults) {
      response += "*2\r\n";
      response += encodeBulkString(streamResult.key);
      response += `*${streamResult.entries.length}\r\n`;
      
      for (const entry of streamResult.entries) {
        response += "*2\r\n";
        response += encodeBulkString(entry.id);
        
        const fieldValues: string[] = [];
        for (const [field, value] of entry.fields) {
          fieldValues.push(field);
          fieldValues.push(value);
        }
        response += `*${fieldValues.length}\r\n`;
        for (const item of fieldValues) {
          response += encodeBulkString(item);
        }
      }
    }
    
    client.socket.write(response);
    
    // Remove this client from blocked list
    blockedXReadClients.splice(i, 1);
  }
}

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

// Helper function to increment key version (for optimistic locking)
function incrementKeyVersion(key: string): void {
  const currentVersion = keyVersions.get(key) || 0;
  keyVersions.set(key, currentVersion + 1);
}

// Helper function to execute a command and return the response
function executeCommand(parsed: string[]): string {
  const command = parsed[0].toLowerCase();
  
  if (command === "set") {
    if (parsed.length >= 3) {
      const key = parsed[1];
      const value = parsed[2];
      let expiresAt: number | undefined = undefined;
      
      for (let i = 3; i < parsed.length; i += 2) {
        const option = parsed[i].toLowerCase();
        if (option === "px") {
          const milliseconds = parseInt(parsed[i + 1]);
          expiresAt = Date.now() + milliseconds;
        } else if (option === "ex") {
          const seconds = parseInt(parsed[i + 1]);
          expiresAt = Date.now() + (seconds * 1000);
        }
      }
      
      store.set(key, { value, expiresAt });
      incrementKeyVersion(key); // Track modification for WATCH
      return "+OK\r\n";
    }
  } else if (command === "get") {
    if (parsed.length >= 2) {
      const key = parsed[1];
      const storedValue = store.get(key);
      
      if (storedValue) {
        if (storedValue.expiresAt && Date.now() > storedValue.expiresAt) {
          store.delete(key);
          return encodeBulkString(null);
        } else {
          return encodeBulkString(storedValue.value);
        }
      } else {
        return encodeBulkString(null);
      }
    }
  } else if (command === "incr") {
    if (parsed.length >= 2) {
      const key = parsed[1];
      const storedValue = store.get(key);
      
      if (storedValue) {
        const trimmedValue = storedValue.value.trim();
        const currentValue = parseInt(trimmedValue);
        
        if (isNaN(currentValue) || !/^-?\d+$/.test(trimmedValue)) {
          return "-ERR value is not an integer or out of range\r\n";
        }
        
        const newValue = currentValue + 1;
        store.set(key, {
          value: newValue.toString(),
          expiresAt: storedValue.expiresAt
        });
        
        incrementKeyVersion(key); // Track modification for WATCH
        return encodeInteger(newValue);
      } else {
        store.set(key, { value: "1" });
        incrementKeyVersion(key); // Track modification for WATCH
        return encodeInteger(1);
      }
    }
  }
  
  return "+OK\r\n";
}

const server: net.Server = net.createServer((connection: net.Socket) => {
  // Initialize authentication for new connection
  // Auto-authenticate as "default" if default user has "nopass" flag
  const defaultUser = users.get("default");
  if (defaultUser && defaultUser.flags.includes("nopass")) {
    authenticatedUser.set(connection, "default");
  } else {
    authenticatedUser.set(connection, null);  // Not authenticated
  }
  
  // Initialize protocol version (default to RESP2)
  protocolVersion.set(connection, 2);
  
  // Handle connection
  connection.on("data", (data: Buffer) => {
    const parsed = parseRESP(data);
    
    if (!parsed || parsed.length === 0) {
      return;
    }
    
    // Get command (case-insensitive)
    const command = parsed[0].toLowerCase();
    
    // Check authentication - some commands don't require authentication
    const commandsWithoutAuth = ["auth", "hello"];  // Commands that work without authentication
    const currentUser = authenticatedUser.get(connection);
    
    if (!currentUser && !commandsWithoutAuth.includes(command)) {
      // Not authenticated and trying to execute a command that requires authentication
      connection.write("-NOAUTH Authentication required.\r\n");
      return;
    }
    
    // Check if client is in subscribed mode
    const clientSubscriptions = subscriptions.get(connection);
    const inSubscribedMode = clientSubscriptions && clientSubscriptions.size > 0;
    
    // If in subscribed mode, only allow specific commands
    if (inSubscribedMode) {
      const allowedInSubscribedMode = [
        "subscribe",
        "unsubscribe",
        "psubscribe",
        "punsubscribe",
        "ping",
        "quit"
      ];
      
      if (!allowedInSubscribedMode.includes(command)) {
        // Return error for disallowed commands
        const errorMsg = `-ERR Can't execute '${command}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context\r\n`;
        connection.write(errorMsg);
        return;
      }
    }
    
    // Check if we're in a transaction and should queue this command
    const inTransaction = transactionState.get(connection);
    if (inTransaction && command !== "exec" && command !== "multi" && command !== "discard") {
      // Queue the command
      let queue = queuedCommands.get(connection);
      if (!queue) {
        queue = [];
        queuedCommands.set(connection, queue);
      }
      queue.push(parsed);
      connection.write("+QUEUED\r\n");
      return;
    }
    
    if (command === "ping") {
      // Check if client is in subscribed mode
      if (inSubscribedMode) {
        // In subscribed mode, respond with array ["pong", ""]
        let response = "*2\r\n";
        response += encodeBulkString("pong");
        response += encodeBulkString("");
        connection.write(response);
      } else {
        // Normal mode: simple string response
        connection.write("+PONG\r\n");
      }
    } else if (command === "info") {
      // INFO command with optional section parameter
      const section = parsed.length >= 2 ? parsed[1].toLowerCase() : "";
      
      // For now, we only handle the replication section
      if (section === "" || section === "replication") {
        let response = `role:${serverRole}`;
        
        // Add master-specific fields if this is a master server
        if (serverRole === "master") {
          response += `\nmaster_replid:${masterReplId}`;
          response += `\nmaster_repl_offset:${masterReplOffset}`;
        }
        
        connection.write(encodeBulkString(response));
      } else {
        // Other sections not implemented yet
        connection.write(encodeBulkString(""));
      }
    } else if (command === "config") {
      // CONFIG command
      if (parsed.length >= 3 && parsed[1].toLowerCase() === "get") {
        const parameter = parsed[2].toLowerCase();
        
        // Build response array: [parameter_name, parameter_value]
        let response = "*2\r\n";
        response += encodeBulkString(parameter);
        
        if (parameter === "dir") {
          response += encodeBulkString(configDir);
        } else if (parameter === "dbfilename") {
          response += encodeBulkString(configDbfilename);
        } else if (parameter === "appendonly") {
          response += encodeBulkString(appendonly ? "yes" : "no");
        } else if (parameter === "appendfilename") {
          response += encodeBulkString(appendfilename);
        } else if (parameter === "appendfsync") {
          response += encodeBulkString(appendfsync);
        } else {
          // Unknown parameter - return empty value
          response += encodeBulkString("");
        }
        
        connection.write(response);
      } else if (parsed.length >= 4 && parsed[1].toLowerCase() === "set") {
        // CONFIG SET parameter value
        const parameter = parsed[2].toLowerCase();
        const value = parsed[3];
        
        if (parameter === "appendonly") {
          const newValue = value.toLowerCase() === "yes";
          if (newValue && !appendonly) {
            // Enabling AOF - open file
            appendonly = true;
            flushAOF(); // Ensure file is created
          } else if (!newValue && appendonly) {
            // Disabling AOF - close file
            appendonly = false;
            if (aofFileDescriptor !== null) {
              flushAOF(); // Flush remaining data
              fs.closeSync(aofFileDescriptor);
              aofFileDescriptor = null;
            }
          }
          connection.write("+OK\r\n");
        } else if (parameter === "appendfilename") {
          appendfilename = value;
          connection.write("+OK\r\n");
        } else if (parameter === "appendfsync") {
          if (value === "always" || value === "everysec" || value === "no") {
            appendfsync = value as "always" | "everysec" | "no";
            connection.write("+OK\r\n");
          } else {
            connection.write("-ERR invalid appendfsync value\r\n");
          }
        } else {
          connection.write("-ERR unsupported CONFIG parameter\r\n");
        }
      }
    } else if (command === "acl") {
      // ACL command - Access Control List management
      if (parsed.length >= 2 && parsed[1].toLowerCase() === "whoami") {
        // ACL WHOAMI returns the username of the current connection
        const username = authenticatedUser.get(connection);
        connection.write(encodeBulkString(username || "default"));
      } else if (parsed.length >= 3 && parsed[1].toLowerCase() === "getuser") {
        // ACL GETUSER returns properties of a specified user
        const username = parsed[2];
        
        // Get the user from storage
        const user = users.get(username);
        
        if (!user) {
          // User not found - for now just return empty response
          // In real Redis, this would return an error
          connection.write(encodeNull(connection));
          return;
        }
        
        // Build response: ["flags", [flag1, flag2, ...], "passwords", [hash1, hash2, ...]]
        let response = "*4\r\n";  // Array with 4 elements
        
        // First element: "flags"
        response += encodeBulkString("flags");
        
        // Second element: array of flags
        response += `*${user.flags.length}\r\n`;
        for (const flag of user.flags) {
          response += encodeBulkString(flag);
        }
        
        // Third element: "passwords"
        response += encodeBulkString("passwords");
        
        // Fourth element: array of password hashes
        response += `*${user.passwords.length}\r\n`;
        for (const passwordHash of user.passwords) {
          response += encodeBulkString(passwordHash);
        }
        
        connection.write(response);
      } else if (parsed.length >= 3 && parsed[1].toLowerCase() === "setuser") {
        // ACL SETUSER modifies a user's properties
        const username = parsed[2];
        
        // Get or create the user
        let user = users.get(username);
        if (!user) {
          user = { flags: [], passwords: [] };
          users.set(username, user);
        }
        
        // Process the rules (arguments after username)
        for (let i = 3; i < parsed.length; i++) {
          const rule = parsed[i];
          
          // Check if this is a password rule (starts with >)
          if (rule.startsWith(">")) {
            const password = rule.substring(1);  // Remove the > prefix
            
            // Compute SHA-256 hash of the password
            const hash = crypto.createHash("sha256").update(password).digest("hex");
            
            // Add the hash to the passwords array
            user.passwords.push(hash);
            
            // Remove the "nopass" flag if it exists
            const nopassIndex = user.flags.indexOf("nopass");
            if (nopassIndex !== -1) {
              user.flags.splice(nopassIndex, 1);
            }
          }
        }
        
        // Return OK
        connection.write("+OK\r\n");
      }
    } else if (command === "hello") {
      // HELLO command - protocol negotiation and connection info
      // Format: HELLO [protover [AUTH username password] [SETNAME clientname]]
      let requestedVersion = 2; // Default to RESP2
      let authUsername: string | null = null;
      let authPassword: string | null = null;
      
      if (parsed.length >= 2) {
        requestedVersion = parseInt(parsed[1]);
      }
      
      // Parse optional AUTH argument
      for (let i = 2; i < parsed.length; i++) {
        if (parsed[i].toLowerCase() === "auth" && i + 2 < parsed.length) {
          authUsername = parsed[i + 1];
          authPassword = parsed[i + 2];
          i += 2;
        }
      }
      
      // Validate protocol version (Redis supports 2 and 3)
      if (requestedVersion !== 2 && requestedVersion !== 3) {
        connection.write("-NOPROTO unsupported protocol version\r\n");
        return;
      }
      
      // Handle authentication if provided
      if (authUsername && authPassword) {
        const user = users.get(authUsername);
        if (!user) {
          connection.write("-WRONGPASS invalid username-password pair or user is disabled.\r\n");
          return;
        }
        
        const passwordHash = crypto.createHash("sha256").update(authPassword).digest("hex");
        if (!user.passwords.includes(passwordHash)) {
          connection.write("-WRONGPASS invalid username-password pair or user is disabled.\r\n");
          return;
        }
        
        // Authentication successful
        authenticatedUser.set(connection, authUsername);
      }
      
      // Set protocol version for this connection
      protocolVersion.set(connection, requestedVersion);
      
      // Build response based on requested protocol version
      if (requestedVersion === 3) {
        // RESP3: Return a map
        const responseMap = new Map<string, string>();
        responseMap.set("server", "redis");
        responseMap.set("version", "7.2.0");
        responseMap.set("proto", "3");
        responseMap.set("id", "1");
        responseMap.set("mode", serverRole === "master" ? "standalone" : "replica");
        responseMap.set("role", serverRole);
        responseMap.set("modules", "");
        
        connection.write(encodeRESP3Map(responseMap));
      } else {
        // RESP2: Return an array
        const response: string[] = [
          "server", "redis",
          "version", "7.2.0",
          "proto", "2",
          "id", "1",
          "mode", serverRole === "master" ? "standalone" : "replica",
          "role", serverRole,
          "modules", ""
        ];
        
        connection.write(encodeArray(response));
      }
    } else if (command === "auth") {
      // AUTH command - authenticates the connection with a username and password
      if (parsed.length >= 3) {
        const username = parsed[1];
        const password = parsed[2];
        
        // Get the user from storage
        const user = users.get(username);
        
        if (!user) {
          // User not found
          connection.write("-WRONGPASS invalid username-password pair or user is disabled.\r\n");
          return;
        }
        
        // Compute SHA-256 hash of the provided password
        const passwordHash = crypto.createHash("sha256").update(password).digest("hex");
        
        // Check if the hash exists in the user's passwords array
        if (user.passwords.includes(passwordHash)) {
          // Password matches - authenticate the connection
          authenticatedUser.set(connection, username);
          connection.write("+OK\r\n");
        } else {
          // Password doesn't match
          connection.write("-WRONGPASS invalid username-password pair or user is disabled.\r\n");
        }
      }
    } else if (command === "replconf") {
      // REPLCONF command - used during replication handshake
      // Don't respond to REPLCONF ACK (sent by replicas in response to GETACK)
      if (parsed.length >= 2 && parsed[1].toLowerCase() === "ack") {
        // This is a REPLCONF ACK response, don't send anything back
        // The ACK listener we set up will handle updating the offset
        return;
      }
      // For other REPLCONF commands, acknowledge with OK
      connection.write("+OK\r\n");
    } else if (command === "psync") {
      // PSYNC command - used during replication handshake
      // Replica sends PSYNC ? -1 for full resynchronization
      // Respond with FULLRESYNC <REPL_ID> <OFFSET>
      const response = `+FULLRESYNC ${masterReplId} ${masterReplOffset}\r\n`;
      connection.write(response);
      
      // Send empty RDB file
      // This is an empty RDB file in hex format
      const emptyRdbHex = "524544495330303131fa0972656469732d76657205372e322e30fa0a72656469732d62697473c040fa056374696d65c26d08bc65fa08757365642d6d656dc2b0c41000fa08616f662d62617365c000fff06e3bfec0ff5aa2";
      
      // Convert hex to binary buffer
      const rdbBuffer = Buffer.from(emptyRdbHex, 'hex');
      
      // Send RDB file in format: $<length>\r\n<contents>
      // Note: No trailing \r\n after contents
      connection.write(`$${rdbBuffer.length}\r\n`);
      connection.write(rdbBuffer);
      
      // Add this connection to the list of replicas
      replicas.push(connection);
      replicaOffsets.set(connection, 0); // Initialize replica offset to 0
      console.log(`Replica connected, total replicas: ${replicas.length}`);
      
      // Set up a data listener for this replica to handle REPLCONF ACK responses
      connection.on("data", (data: Buffer) => {
        const parsed = parseRESP(data);
        if (parsed && parsed.length >= 3) {
          const cmd = parsed[0].toLowerCase();
          if (cmd === "replconf" && parsed[1].toLowerCase() === "ack") {
            // Update the replica's offset
            const offset = parseInt(parsed[2]);
            replicaOffsets.set(connection, offset);
            console.log(`Replica ACK received: offset ${offset}`);
          }
        }
      });
    } else if (command === "watch") {
      // WATCH command - mark keys to watch for modifications
      if (parsed.length >= 2) {
        // Get or create watched keys set for this connection
        let watched = watchedKeys.get(connection);
        if (!watched) {
          watched = new Set<string>();
          watchedKeys.set(connection, watched);
        }
        
        // Add all specified keys to watched set
        for (let i = 1; i < parsed.length; i++) {
          watched.add(parsed[i]);
        }
        
        connection.write("+OK\r\n");
      }
    } else if (command === "unwatch") {
      // UNWATCH command - remove all watched keys
      watchedKeys.delete(connection);
      watchedKeyVersions.delete(connection);
      connection.write("+OK\r\n");
    } else if (command === "multi") {
      // Start a transaction
      transactionState.set(connection, true);
      queuedCommands.set(connection, []);
      
      // Snapshot current versions of watched keys
      const watched = watchedKeys.get(connection);
      if (watched && watched.size > 0) {
        const versionSnapshot = new Map<string, number>();
        for (const key of watched) {
          versionSnapshot.set(key, keyVersions.get(key) || 0);
        }
        watchedKeyVersions.set(connection, versionSnapshot);
      }
      
      connection.write("+OK\r\n");
    } else if (command === "exec") {
      // Check if MULTI was called
      const inTransaction = transactionState.get(connection);
      if (!inTransaction) {
        connection.write("-ERR EXEC without MULTI\r\n");
      } else {
        // Check if any watched keys have been modified
        const versionSnapshot = watchedKeyVersions.get(connection);
        let transactionAborted = false;
        
        if (versionSnapshot && versionSnapshot.size > 0) {
          // Compare current versions with snapshot
          for (const [key, snapshotVersion] of versionSnapshot) {
            const currentVersion = keyVersions.get(key) || 0;
            if (currentVersion !== snapshotVersion) {
              // Key was modified by another client - abort transaction
              transactionAborted = true;
              break;
            }
          }
        }
        
        // Get queued commands
        const queue = queuedCommands.get(connection) || [];
        
        // Clear the transaction state, queue, and watched keys
        transactionState.delete(connection);
        queuedCommands.delete(connection);
        watchedKeys.delete(connection);
        watchedKeyVersions.delete(connection);
        
        if (transactionAborted) {
          // Return null bulk string to indicate transaction was aborted
          connection.write(encodeNull(connection));
        } else {
          // Execute all queued commands and collect responses
          const responses: string[] = [];
          for (const queuedCmd of queue) {
            const response = executeCommand(queuedCmd);
            responses.push(response);
          }
          
          // Build the array response
          let arrayResponse = `*${responses.length}\r\n`;
          for (const response of responses) {
            arrayResponse += response;
          }
          
          connection.write(arrayResponse);
        }
      }
    } else if (command === "discard") {
      // Check if MULTI was called
      const inTransaction = transactionState.get(connection);
      if (!inTransaction) {
        connection.write("-ERR DISCARD without MULTI\r\n");
      } else {
        // Abort the transaction - clear state, queue, and watched keys
        transactionState.delete(connection);
        queuedCommands.delete(connection);
        watchedKeys.delete(connection);
        watchedKeyVersions.delete(connection);
        connection.write("+OK\r\n");
      }
    } else if (command === "bgrewriteaof") {
      // BGREWRITEAOF command - rewrite AOF file to minimize size
      if (!appendonly) {
        connection.write("-ERR AOF is not enabled\r\n");
        return;
      }
      
      try {
        // Flush current AOF buffer first
        flushAOF();
        
        // Create new AOF file with current state
        const tempAofPath = `${configDir}/${appendfilename}.temp`;
        const tempFd = fs.openSync(tempAofPath, 'w');
        
        // Write all current data as commands
        const commands: string[] = [];
        
        // Write all strings
        for (const [key, storedValue] of store.entries()) {
          if (!storedValue.expiresAt || storedValue.expiresAt > Date.now()) {
            let cmd = `*3\r\n$3\r\nSET\r\n$${key.length}\r\n${key}\r\n$${storedValue.value.length}\r\n${storedValue.value}\r\n`;
            commands.push(cmd);
          }
        }
        
        // Write all sets
        for (const [key, set] of sets.entries()) {
          if (set.size > 0) {
            const members = Array.from(set);
            let cmd = `*${2 + members.length}\r\n$4\r\nSADD\r\n$${key.length}\r\n${key}\r\n`;
            for (const member of members) {
              cmd += `$${member.length}\r\n${member}\r\n`;
            }
            commands.push(cmd);
          }
        }
        
        // Write all lists
        for (const [key, list] of lists.entries()) {
          if (list.length > 0) {
            let cmd = `*${2 + list.length}\r\n$5\r\nRPUSH\r\n$${key.length}\r\n${key}\r\n`;
            for (const item of list) {
              cmd += `$${item.length}\r\n${item}\r\n`;
            }
            commands.push(cmd);
          }
        }
        
        // Write commands to temp file
        const data = commands.join('');
        fs.writeSync(tempFd, data);
        fs.fsyncSync(tempFd);
        fs.closeSync(tempFd);
        
        // Close current AOF file
        if (aofFileDescriptor !== null) {
          fs.closeSync(aofFileDescriptor);
          aofFileDescriptor = null;
        }
        
        // Rename temp file to actual AOF file
        const aofPath = `${configDir}/${appendfilename}`;
        fs.renameSync(tempAofPath, aofPath);
        
        // Reopen AOF file
        aofFileDescriptor = fs.openSync(aofPath, 'a');
        
        connection.write("+Background append only file rewriting started\r\n");
      } catch (error) {
        connection.write(`-ERR failed to rewrite AOF: ${error}\r\n`);
      }
    } else if (command === "wait") {
      // WAIT <numreplicas> <timeout>
      if (parsed.length >= 3) {
        const numreplicas = parseInt(parsed[1]);
        const timeout = parseInt(parsed[2]);
        
        // If no write commands have been sent, all replicas are in sync
        if (masterReplOffset === 0) {
          connection.write(encodeInteger(replicas.length));
          return;
        }
        
        // Send REPLCONF GETACK * to all replicas
        const getackCommand = "*3\r\n$8\r\nREPLCONF\r\n$6\r\nGETACK\r\n$1\r\n*\r\n";
        for (const replica of replicas) {
          replica.write(getackCommand);
        }
        
        // Function to count replicas that have acknowledged all commands
        const countAckedReplicas = (): number => {
          let count = 0;
          for (const replica of replicas) {
            const replicaOffset = replicaOffsets.get(replica) || 0;
            if (replicaOffset >= masterReplOffset) {
              count++;
            }
          }
          return count;
        };
        
        // Set up polling to check for acknowledgements
        const startTime = Date.now();
        const checkInterval = 10; // Check every 10ms
        
        const checkAcks = () => {
          const ackedCount = countAckedReplicas();
          
          // Check if we've met the requirement or timed out
          if (ackedCount >= numreplicas || Date.now() - startTime >= timeout) {
            connection.write(encodeInteger(ackedCount));
          } else {
            // Continue polling
            setTimeout(checkAcks, checkInterval);
          }
        };
        
        // Start checking
        setTimeout(checkAcks, checkInterval);
      }
    } else if (command === "echo") {
      // ECHO requires one argument
      if (parsed.length >= 2) {
        const message = parsed[1];
        connection.write(encodeBulkString(message));
      }
    } else if (command === "keys") {
      // KEYS command - returns all keys matching pattern
      if (parsed.length >= 2) {
        const pattern = parsed[1];
        
        // For now, only support "*" (all keys)
        if (pattern === "*") {
          const keys: string[] = [];
          
          // Get all keys from store (excluding expired ones)
          for (const [key, storedValue] of store.entries()) {
            // Check if key has expired
            if (storedValue.expiresAt && Date.now() > storedValue.expiresAt) {
              // Key expired, skip it
              store.delete(key);
              continue;
            }
            keys.push(key);
          }
          
          // Return as RESP array
          connection.write(encodeArray(keys));
        } else {
          // Pattern matching not implemented yet
          connection.write("*0\r\n");
        }
      }
    } else if (command === "subscribe") {
      // SUBSCRIBE command - subscribe to a channel
      if (parsed.length >= 2) {
        const channelName = parsed[1];
        
        // Get or create subscription set for this connection
        let channels = subscriptions.get(connection);
        if (!channels) {
          channels = new Set<string>();
          subscriptions.set(connection, channels);
        }
        
        // Add channel to subscription set
        channels.add(channelName);
        
        // Build response: ["subscribe", channel_name, num_subscriptions]
        // Format: *3\r\n$9\r\nsubscribe\r\n$<len>\r\n<channel>\r\n:<count>\r\n
        let response = "*3\r\n";
        response += encodeBulkString("subscribe");
        response += encodeBulkString(channelName);
        response += encodeInteger(channels.size);
        
        connection.write(response);
      }
    } else if (command === "unsubscribe") {
      // UNSUBSCRIBE command - unsubscribe from a channel
      if (parsed.length >= 2) {
        const channelName = parsed[1];
        
        // Get the client's subscription set
        let channels = subscriptions.get(connection);
        if (!channels) {
          channels = new Set<string>();
          subscriptions.set(connection, channels);
        }
        
        // Remove channel from subscription set (if it exists)
        channels.delete(channelName);
        
        // Build response: ["unsubscribe", channel_name, remaining_count]
        let response = "*3\r\n";
        response += encodeBulkString("unsubscribe");
        response += encodeBulkString(channelName);
        response += encodeInteger(channels.size);
        
        connection.write(response);
        
        // If no more subscriptions, client exits subscribed mode
        // (this happens automatically via inSubscribedMode check)
        if (channels.size === 0) {
          subscriptions.delete(connection);
        }
      }
    } else if (command === "publish") {
      // PUBLISH command - publish a message to a channel
      if (parsed.length >= 3) {
        const channelName = parsed[1];
        const message = parsed[2];
        
        // Build the message to send to subscribers: ["message", channel_name, message_contents]
        let messageToSubscribers = "*3\r\n";
        messageToSubscribers += encodeBulkString("message");
        messageToSubscribers += encodeBulkString(channelName);
        messageToSubscribers += encodeBulkString(message);
        
        // Deliver message to all subscribed clients and count them
        let subscriberCount = 0;
        for (const [clientSocket, channels] of subscriptions.entries()) {
          if (channels.has(channelName)) {
            subscriberCount++;
            // Send the message to this subscriber
            clientSocket.write(messageToSubscribers);
          }
        }
        
        // Return the number of subscribers as a RESP integer to the publisher
        connection.write(encodeInteger(subscriberCount));
      }
    } else if (command === "sadd") {
      // SADD command - add one or more members to a set
      // Format: SADD key member [member ...]
      if (parsed.length >= 3) {
        const key = parsed[1];
        const members = parsed.slice(2);
        
        // Get or create the set
        let set = sets.get(key);
        if (!set) {
          set = new Set<string>();
          sets.set(key, set);
        }
        
        // Add members and count how many were actually added (not already in set)
        let addedCount = 0;
        for (const member of members) {
          const sizeBefore = set.size;
          set.add(member);
          if (set.size > sizeBefore) {
            addedCount++;
          }
        }
        
        incrementKeyVersion(key); // Track modification for WATCH
        
        // Log to AOF
        appendToAOF(parsed);
        
        // Return the number of new members added
        connection.write(encodeInteger(addedCount));
      }
    } else if (command === "smembers") {
      // SMEMBERS command - get all members of a set
      // Format: SMEMBERS key
      if (parsed.length >= 2) {
        const key = parsed[1];
        const set = sets.get(key);
        
        if (!set) {
          // Set doesn't exist - return empty array
          connection.write("*0\r\n");
        } else {
          // Return all members as an array
          const members = Array.from(set);
          connection.write(encodeArray(members));
        }
      }
    } else if (command === "sismember") {
      // SISMEMBER command - check if member is in set
      // Format: SISMEMBER key member
      if (parsed.length >= 3) {
        const key = parsed[1];
        const member = parsed[2];
        const set = sets.get(key);
        
        if (!set || !set.has(member)) {
          // Set doesn't exist or member not in set
          connection.write(encodeInteger(0));
        } else {
          // Member is in set
          connection.write(encodeInteger(1));
        }
      }
    } else if (command === "srem") {
      // SREM command - remove one or more members from a set
      // Format: SREM key member [member ...]
      if (parsed.length >= 3) {
        const key = parsed[1];
        const members = parsed.slice(2);
        const set = sets.get(key);
        
        if (!set) {
          // Set doesn't exist - return 0
          connection.write(encodeInteger(0));
        } else {
          // Remove members and count how many were actually removed
          let removedCount = 0;
          for (const member of members) {
            if (set.delete(member)) {
              removedCount++;
            }
          }
          
          // Clean up empty set
          if (set.size === 0) {
            sets.delete(key);
          }
          
          if (removedCount > 0) {
            incrementKeyVersion(key); // Track modification for WATCH
          }
          
          // Return the number of members removed
          connection.write(encodeInteger(removedCount));
        }
      }
    } else if (command === "scard") {
      // SCARD command - get the cardinality (number of members) of a set
      // Format: SCARD key
      if (parsed.length >= 2) {
        const key = parsed[1];
        const set = sets.get(key);
        
        if (!set) {
          // Set doesn't exist - return 0
          connection.write(encodeInteger(0));
        } else {
          // Return the number of members
          connection.write(encodeInteger(set.size));
        }
      }
    } else if (command === "sinter") {
      // SINTER command - get the intersection of multiple sets
      // Format: SINTER key [key ...]
      if (parsed.length >= 2) {
        const keys = parsed.slice(1);
        
        // Start with the first set
        const firstSet = sets.get(keys[0]);
        if (!firstSet || firstSet.size === 0) {
          // If first set doesn't exist or is empty, intersection is empty
          connection.write("*0\r\n");
          return;
        }
        
        // Find intersection with all other sets
        const intersection = new Set<string>();
        for (const member of firstSet) {
          let inAllSets = true;
          
          // Check if this member is in all other sets
          for (let i = 1; i < keys.length; i++) {
            const otherSet = sets.get(keys[i]);
            if (!otherSet || !otherSet.has(member)) {
              inAllSets = false;
              break;
            }
          }
          
          if (inAllSets) {
            intersection.add(member);
          }
        }
        
        // Return the intersection as an array
        const members = Array.from(intersection);
        connection.write(encodeArray(members));
      }
    } else if (command === "sunion") {
      // SUNION command - get the union of multiple sets
      // Format: SUNION key [key ...]
      if (parsed.length >= 2) {
        const keys = parsed.slice(1);
        const union = new Set<string>();
        
        // Add all members from all sets to the union
        for (const key of keys) {
          const set = sets.get(key);
          if (set) {
            for (const member of set) {
              union.add(member);
            }
          }
        }
        
        // Return the union as an array
        const members = Array.from(union);
        connection.write(encodeArray(members));
      }
    } else if (command === "sdiff") {
      // SDIFF command - get the difference between first set and all others
      // Format: SDIFF key [key ...]
      if (parsed.length >= 2) {
        const keys = parsed.slice(1);
        
        // Start with the first set
        const firstSet = sets.get(keys[0]);
        if (!firstSet || firstSet.size === 0) {
          // If first set doesn't exist or is empty, difference is empty
          connection.write("*0\r\n");
          return;
        }
        
        // Create a copy of the first set
        const difference = new Set<string>(firstSet);
        
        // Remove members that exist in any other set
        for (let i = 1; i < keys.length; i++) {
          const otherSet = sets.get(keys[i]);
          if (otherSet) {
            for (const member of otherSet) {
              difference.delete(member);
            }
          }
        }
        
        // Return the difference as an array
        const members = Array.from(difference);
        connection.write(encodeArray(members));
      }
    } else if (command === "bf.reserve") {
      // BF.RESERVE command - create a bloom filter with custom parameters
      // Format: BF.RESERVE key error_rate capacity
      if (parsed.length >= 4) {
        const key = parsed[1];
        const errorRate = parseFloat(parsed[2]);
        const capacity = parseInt(parsed[3]);
        
        // Check if bloom filter already exists
        if (bloomFilters.has(key)) {
          connection.write("-ERR item exists\r\n");
          return;
        }
        
        // Validate parameters
        if (errorRate <= 0 || errorRate >= 1) {
          connection.write("-ERR error rate must be between 0 and 1\r\n");
          return;
        }
        
        if (capacity <= 0) {
          connection.write("-ERR capacity must be positive\r\n");
          return;
        }
        
        // Create new bloom filter
        const bf = new BloomFilter(capacity, errorRate);
        bloomFilters.set(key, bf);
        incrementKeyVersion(key);
        
        connection.write("+OK\r\n");
      }
    } else if (command === "bf.add") {
      // BF.ADD command - add an item to a bloom filter
      // Format: BF.ADD key item
      if (parsed.length >= 3) {
        const key = parsed[1];
        const item = parsed[2];
        
        // Get or create bloom filter (auto-create with defaults)
        let bf = bloomFilters.get(key);
        if (!bf) {
          bf = new BloomFilter(100, 0.01); // Default: 100 capacity, 1% error rate
          bloomFilters.set(key, bf);
        }
        
        // Add item and return result
        const added = bf.add(item);
        incrementKeyVersion(key);
        
        // Return 1 if newly added, 0 if already existed (might exist)
        connection.write(encodeInteger(added ? 1 : 0));
      }
    } else if (command === "bf.exists") {
      // BF.EXISTS command - check if an item exists in a bloom filter
      // Format: BF.EXISTS key item
      if (parsed.length >= 3) {
        const key = parsed[1];
        const item = parsed[2];
        
        const bf = bloomFilters.get(key);
        
        if (!bf) {
          // Bloom filter doesn't exist, item definitely doesn't exist
          connection.write(encodeInteger(0));
        } else {
          // Check if item exists (might be false positive)
          const exists = bf.exists(item);
          connection.write(encodeInteger(exists ? 1 : 0));
        }
      }
    } else if (command === "bf.madd") {
      // BF.MADD command - add multiple items to a bloom filter
      // Format: BF.MADD key item [item ...]
      if (parsed.length >= 3) {
        const key = parsed[1];
        const items = parsed.slice(2);
        
        // Get or create bloom filter
        let bf = bloomFilters.get(key);
        if (!bf) {
          bf = new BloomFilter(100, 0.01);
          bloomFilters.set(key, bf);
        }
        
        // Add all items and collect results
        const results: number[] = [];
        for (const item of items) {
          const added = bf.add(item);
          results.push(added ? 1 : 0);
        }
        
        incrementKeyVersion(key);
        
        // Return array of results
        let response = `*${results.length}\r\n`;
        for (const result of results) {
          response += encodeInteger(result);
        }
        connection.write(response);
      }
    } else if (command === "bf.mexists") {
      // BF.MEXISTS command - check if multiple items exist in a bloom filter
      // Format: BF.MEXISTS key item [item ...]
      if (parsed.length >= 3) {
        const key = parsed[1];
        const items = parsed.slice(2);
        
        const bf = bloomFilters.get(key);
        
        // Check all items
        const results: number[] = [];
        for (const item of items) {
          if (!bf) {
            results.push(0);
          } else {
            const exists = bf.exists(item);
            results.push(exists ? 1 : 0);
          }
        }
        
        // Return array of results
        let response = `*${results.length}\r\n`;
        for (const result of results) {
          response += encodeInteger(result);
        }
        connection.write(response);
      }
    } else if (command === "bf.info") {
      // BF.INFO command - get information about a bloom filter
      // Format: BF.INFO key
      if (parsed.length >= 2) {
        const key = parsed[1];
        const bf = bloomFilters.get(key);
        
        if (!bf) {
          connection.write("-ERR not found\r\n");
        } else {
          const info = bf.getInfo();
          
          // Return as array of key-value pairs
          const response: string[] = [
            "Capacity", info.capacity.toString(),
            "Size", info.size.toString(),
            "Number of filters", info.numFilters.toString(),
            "Number of items inserted", info.numItemsInserted.toString(),
            "Expansion rate", info.expansionRate.toString()
          ];
          
          connection.write(encodeArray(response));
        }
      }
    } else if (command === "zadd") {
      // ZADD command - add member to sorted set with score
      if (parsed.length >= 4) {
        const key = parsed[1];
        const score = parseFloat(parsed[2]);
        const member = parsed[3];
        
        // Get or create sorted set
        let sortedSet = sortedSets.get(key);
        if (!sortedSet) {
          sortedSet = [];
          sortedSets.set(key, sortedSet);
        }
        
        // Check if member already exists
        const existingIndex = sortedSet.findIndex(m => m.member === member);
        let newMembersAdded = 0;
        
        if (existingIndex === -1) {
          // New member - add it in sorted position
          newMembersAdded = 1;
          
          // Find the correct position to insert (maintain sorted order by score, then lexicographically)
          let insertIndex = 0;
          for (let i = 0; i < sortedSet.length; i++) {
            if (sortedSet[i].score > score) {
              break;
            } else if (sortedSet[i].score === score && sortedSet[i].member > member) {
              // Same score, but lexicographically after the new member
              break;
            }
            insertIndex = i + 1;
          }
          
          // Insert at the correct position
          sortedSet.splice(insertIndex, 0, { member, score });
        } else {
          // Member exists - update score if different
          if (sortedSet[existingIndex].score !== score) {
            // Remove old entry
            sortedSet.splice(existingIndex, 1);
            
            // Find new position and insert (maintain sorted order by score, then lexicographically)
            let insertIndex = 0;
            for (let i = 0; i < sortedSet.length; i++) {
              if (sortedSet[i].score > score) {
                break;
              } else if (sortedSet[i].score === score && sortedSet[i].member > member) {
                // Same score, but lexicographically after the new member
                break;
              }
              insertIndex = i + 1;
            }
            sortedSet.splice(insertIndex, 0, { member, score });
          }
          // newMembersAdded remains 0 since member already existed
        }
        
        incrementKeyVersion(key); // Track modification for WATCH
        
        // Return the number of new members added
        connection.write(encodeInteger(newMembersAdded));
      }
    } else if (command === "zrank") {
      // ZRANK command - get the rank (index) of a member in a sorted set
      if (parsed.length >= 3) {
        const key = parsed[1];
        const member = parsed[2];
        
        // Check if sorted set exists
        const sortedSet = sortedSets.get(key);
        if (!sortedSet) {
          // Sorted set doesn't exist
          connection.write(encodeNull(connection));
          return;
        }
        
        // Find the member in the sorted set
        const memberIndex = sortedSet.findIndex(m => m.member === member);
        
        if (memberIndex === -1) {
          // Member doesn't exist
          connection.write(encodeNull(connection));
        } else {
          // Return the rank (0-based index)
          connection.write(encodeInteger(memberIndex));
        }
      }
    } else if (command === "zrange") {
      // ZRANGE command - list members in a sorted set by index range
      if (parsed.length >= 4) {
        const key = parsed[1];
        let startIndex = parseInt(parsed[2]);
        let stopIndex = parseInt(parsed[3]);
        
        // Check if sorted set exists
        const sortedSet = sortedSets.get(key);
        if (!sortedSet) {
          // Sorted set doesn't exist - return empty array
          connection.write("*0\r\n");
          return;
        }
        
        // Get the cardinality (size) of the sorted set
        const cardinality = sortedSet.length;
        
        // Convert negative indexes to positive
        if (startIndex < 0) {
          startIndex = cardinality + startIndex;
          // If still negative (out of range), clamp to 0
          if (startIndex < 0) {
            startIndex = 0;
          }
        }
        
        if (stopIndex < 0) {
          stopIndex = cardinality + stopIndex;
          // If still negative (out of range), clamp to 0
          if (stopIndex < 0) {
            stopIndex = 0;
          }
        }
        
        // If start index >= cardinality, return empty array
        if (startIndex >= cardinality) {
          connection.write("*0\r\n");
          return;
        }
        
        // If start > stop, return empty array
        if (startIndex > stopIndex) {
          connection.write("*0\r\n");
          return;
        }
        
        // Adjust stop index if it's greater than cardinality
        const adjustedStopIndex = Math.min(stopIndex, cardinality - 1);
        
        // Extract the range (slice is exclusive at end, so add 1)
        const members = sortedSet.slice(startIndex, adjustedStopIndex + 1).map(m => m.member);
        
        // Return as RESP array
        connection.write(encodeArray(members));
      }
    } else if (command === "zcard") {
      // ZCARD command - get the cardinality (number of elements) of a sorted set
      if (parsed.length >= 2) {
        const key = parsed[1];
        
        // Check if sorted set exists
        const sortedSet = sortedSets.get(key);
        if (!sortedSet) {
          // Sorted set doesn't exist - return 0
          connection.write(encodeInteger(0));
        } else {
          // Return the number of elements
          connection.write(encodeInteger(sortedSet.length));
        }
      }
    } else if (command === "zscore") {
      // ZSCORE command - get the score of a member in a sorted set
      if (parsed.length >= 3) {
        const key = parsed[1];
        const member = parsed[2];
        
        // Check if sorted set exists
        const sortedSet = sortedSets.get(key);
        if (!sortedSet) {
          // Sorted set doesn't exist - return null bulk string
          connection.write(encodeNull(connection));
          return;
        }
        
        // Find the member in the sorted set
        const foundMember = sortedSet.find(m => m.member === member);
        
        if (!foundMember) {
          // Member doesn't exist - return null bulk string
          connection.write(encodeNull(connection));
        } else {
          // Return the score as a bulk string
          const scoreStr = foundMember.score.toString();
          connection.write(encodeBulkString(scoreStr));
        }
      }
    } else if (command === "zrem") {
      // ZREM command - remove a member from a sorted set
      if (parsed.length >= 3) {
        const key = parsed[1];
        const member = parsed[2];
        
        // Check if sorted set exists
        const sortedSet = sortedSets.get(key);
        if (!sortedSet) {
          // Sorted set doesn't exist - return 0
          connection.write(encodeInteger(0));
          return;
        }
        
        // Find the index of the member in the sorted set
        const memberIndex = sortedSet.findIndex(m => m.member === member);
        
        if (memberIndex === -1) {
          // Member doesn't exist - return 0
          connection.write(encodeInteger(0));
        } else {
          // Remove the member from the sorted set
          sortedSet.splice(memberIndex, 1);
          incrementKeyVersion(key); // Track modification for WATCH
          // Return 1 (number of members removed)
          connection.write(encodeInteger(1));
        }
      }
    } else if (command === "geoadd") {
      // GEOADD command - add a geospatial location
      // Format: GEOADD key longitude latitude member
      if (parsed.length >= 5) {
        const key = parsed[1];
        const longitude = parseFloat(parsed[2]);
        const latitude = parseFloat(parsed[3]);
        const member = parsed[4];
        
        // Validate longitude: -180 to +180 (inclusive)
        if (longitude < -180 || longitude > 180) {
          connection.write(`-ERR invalid longitude,latitude pair ${longitude},${latitude}\r\n`);
          return;
        }
        
        // Validate latitude: -85.05112878 to +85.05112878 (inclusive)
        if (latitude < -85.05112878 || latitude > 85.05112878) {
          connection.write(`-ERR invalid longitude,latitude pair ${longitude},${latitude}\r\n`);
          return;
        }
        
        // Store location in sorted set
        // Calculate geohash score from longitude and latitude
        const score = encodeGeohash(longitude, latitude);
        
        // Get or create sorted set
        let sortedSet = sortedSets.get(key);
        if (!sortedSet) {
          sortedSet = [];
          sortedSets.set(key, sortedSet);
        }
        
        // Check if member already exists
        const existingIndex = sortedSet.findIndex(m => m.member === member);
        let newMembersAdded = 0;
        
        if (existingIndex === -1) {
          // New member - add it in sorted position
          newMembersAdded = 1;
          
          // Find the correct position to insert (maintain sorted order by score, then lexicographically)
          let insertIndex = 0;
          for (let i = 0; i < sortedSet.length; i++) {
            if (sortedSet[i].score > score) {
              break;
            } else if (sortedSet[i].score === score && sortedSet[i].member > member) {
              break;
            }
            insertIndex = i + 1;
          }
          
          // Insert at the correct position
          sortedSet.splice(insertIndex, 0, { member, score });
        } else {
          // Member exists - update score if different
          if (sortedSet[existingIndex].score !== score) {
            // Remove old entry
            sortedSet.splice(existingIndex, 1);
            
            // Find new position and insert
            let insertIndex = 0;
            for (let i = 0; i < sortedSet.length; i++) {
              if (sortedSet[i].score > score) {
                break;
              } else if (sortedSet[i].score === score && sortedSet[i].member > member) {
                break;
              }
              insertIndex = i + 1;
            }
            sortedSet.splice(insertIndex, 0, { member, score });
          }
          // newMembersAdded remains 0 since member already existed
        }
        
        incrementKeyVersion(key); // Track modification for WATCH
        
        // Return the number of new members added
        connection.write(encodeInteger(newMembersAdded));
      }
    } else if (command === "geopos") {
      // GEOPOS command - get the longitude and latitude of locations
      // Format: GEOPOS key member [member ...]
      if (parsed.length >= 3) {
        const key = parsed[1];
        const members = parsed.slice(2); // Get all member names
        
        // Get the sorted set
        const sortedSet = sortedSets.get(key);
        
        // Build response array - one entry per requested member
        let response = `*${members.length}\r\n`;
        
        for (const member of members) {
          // Find the member in the sorted set
          const foundMember = sortedSet ? sortedSet.find(m => m.member === member) : undefined;
          
          if (foundMember) {
            // Member exists - decode geohash to get longitude and latitude
            const { longitude, latitude } = decodeGeohash(foundMember.score);
            
            // Return [longitude, latitude] as bulk strings
            response += "*2\r\n";
            response += encodeBulkString(longitude.toString());
            response += encodeBulkString(latitude.toString());
          } else {
            // Member or key doesn't exist - return null array
            response += "*-1\r\n";
          }
        }
        
        connection.write(response);
      }
    } else if (command === "geodist") {
      // GEODIST command - calculate distance between two locations
      // Format: GEODIST key member1 member2 [unit]
      if (parsed.length >= 4) {
        const key = parsed[1];
        const member1 = parsed[2];
        const member2 = parsed[3];
        // Unit is optional (m, km, ft, mi), default is meters
        // For now we'll just handle meters
        
        // Get the sorted set
        const sortedSet = sortedSets.get(key);
        
        if (!sortedSet) {
          // Key doesn't exist - return null
          connection.write(encodeNull(connection));
          return;
        }
        
        // Find both members
        const foundMember1 = sortedSet.find(m => m.member === member1);
        const foundMember2 = sortedSet.find(m => m.member === member2);
        
        if (!foundMember1 || !foundMember2) {
          // One or both members don't exist - return null
          connection.write(encodeNull(connection));
          return;
        }
        
        // Decode geohashes to get coordinates
        const coords1 = decodeGeohash(foundMember1.score);
        const coords2 = decodeGeohash(foundMember2.score);
        
        // Calculate distance using Haversine formula
        const distance = calculateDistance(
          coords1.longitude, coords1.latitude,
          coords2.longitude, coords2.latitude
        );
        
        // Return distance as bulk string
        connection.write(encodeBulkString(distance.toString()));
      }
    } else if (command === "geosearch") {
      // GEOSEARCH command - search for locations within a radius
      // Format: GEOSEARCH key FROMLONLAT lon lat BYRADIUS radius unit
      if (parsed.length >= 8) {
        const key = parsed[1];
        
        // Parse FROMLONLAT option
        const fromlonlatIndex = parsed.findIndex(p => p.toLowerCase() === "fromlonlat");
        if (fromlonlatIndex === -1 || fromlonlatIndex + 2 >= parsed.length) {
          connection.write("-ERR syntax error\r\n");
          return;
        }
        
        const centerLon = parseFloat(parsed[fromlonlatIndex + 1]);
        const centerLat = parseFloat(parsed[fromlonlatIndex + 2]);
        
        // Parse BYRADIUS option
        const byradiusIndex = parsed.findIndex(p => p.toLowerCase() === "byradius");
        if (byradiusIndex === -1 || byradiusIndex + 2 >= parsed.length) {
          connection.write("-ERR syntax error\r\n");
          return;
        }
        
        const radius = parseFloat(parsed[byradiusIndex + 1]);
        const unit = parsed[byradiusIndex + 2].toLowerCase();
        
        // Convert radius to meters based on unit
        let radiusInMeters = radius;
        if (unit === "km") {
          radiusInMeters = radius * 1000;
        } else if (unit === "mi") {
          radiusInMeters = radius * 1609.34;
        } else if (unit === "ft") {
          radiusInMeters = radius * 0.3048;
        }
        // else assume meters (m)
        
        // Get the sorted set
        const sortedSet = sortedSets.get(key);
        
        if (!sortedSet) {
          // Key doesn't exist - return empty array
          connection.write("*0\r\n");
          return;
        }
        
        // Find all members within the radius
        const matchingMembers: string[] = [];
        
        for (const member of sortedSet) {
          // Decode geohash to get coordinates
          const coords = decodeGeohash(member.score);
          
          // Calculate distance from center point
          const distance = calculateDistance(
            centerLon, centerLat,
            coords.longitude, coords.latitude
          );
          
          // If within radius, add to results
          if (distance <= radiusInMeters) {
            matchingMembers.push(member.member);
          }
        }
        
        // Return array of matching members
        connection.write(encodeArray(matchingMembers));
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
        incrementKeyVersion(key); // Track modification for WATCH
        
        // Log to AOF
        appendToAOF(parsed);
        
        connection.write("+OK\r\n");
        
        // Propagate write command to replicas
        if (serverRole === "master") {
          propagateToReplicas(parsed);
        }
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
            connection.write(encodeNull(connection));
          } else {
            // Key is valid, return the value
            connection.write(encodeBulkString(storedValue.value));
          }
        } else {
          // Key doesn't exist
          connection.write(encodeNull(connection));
        }
      }
    } else if (command === "incr") {
      // INCR requires one argument: key
      if (parsed.length >= 2) {
        const key = parsed[1];
        const storedValue = store.get(key);
        
        if (storedValue) {
          // Key exists - validate and parse current value as integer
          const trimmedValue = storedValue.value.trim();
          const currentValue = parseInt(trimmedValue);
          
          // Check if the value is a valid integer
          // Must not be NaN and the trimmed string should match the integer pattern
          if (isNaN(currentValue) || !/^-?\d+$/.test(trimmedValue)) {
            // Value is not a valid integer
            connection.write("-ERR value is not an integer or out of range\r\n");
            return;
          }
          
          const newValue = currentValue + 1;
          
          // Store the new value (preserve expiry if it exists)
          store.set(key, {
            value: newValue.toString(),
            expiresAt: storedValue.expiresAt
          });
          
          incrementKeyVersion(key); // Track modification for WATCH
          // Return the new value as RESP integer
          connection.write(encodeInteger(newValue));
        } else {
          // Key doesn't exist - set to 1
          store.set(key, {
            value: "1"
          });
          
          incrementKeyVersion(key); // Track modification for WATCH
          // Return 1 as RESP integer
          connection.write(encodeInteger(1));
        }
      }
    } else if (command === "setbit") {
      // SETBIT command - set bit at offset
      // Format: SETBIT key offset value
      if (parsed.length >= 4) {
        const key = parsed[1];
        const offset = parseInt(parsed[2]);
        const value = parseInt(parsed[3]);
        
        // Validate offset and value
        if (offset < 0) {
          connection.write("-ERR bit offset is not an integer or out of range\r\n");
          return;
        }
        
        if (value !== 0 && value !== 1) {
          connection.write("-ERR bit is not an integer or out of range\r\n");
          return;
        }
        
        // Get current value or create empty string
        const storedValue = store.get(key);
        let binaryData = storedValue ? Buffer.from(storedValue.value, 'binary') : Buffer.alloc(0);
        
        // Calculate byte and bit position
        const byteIndex = Math.floor(offset / 8);
        const bitIndex = 7 - (offset % 8); // MSB first
        
        // Expand buffer if necessary
        if (byteIndex >= binaryData.length) {
          const newBuffer = Buffer.alloc(byteIndex + 1);
          binaryData.copy(newBuffer);
          binaryData = newBuffer;
        }
        
        // Get old bit value
        const oldBit = (binaryData[byteIndex] >> bitIndex) & 1;
        
        // Set new bit value
        if (value === 1) {
          binaryData[byteIndex] |= (1 << bitIndex);
        } else {
          binaryData[byteIndex] &= ~(1 << bitIndex);
        }
        
        // Store updated value
        store.set(key, {
          value: binaryData.toString('binary'),
          expiresAt: storedValue?.expiresAt
        });
        
        incrementKeyVersion(key);
        appendToAOF(parsed);
        
        // Return old bit value
        connection.write(encodeInteger(oldBit));
      }
    } else if (command === "getbit") {
      // GETBIT command - get bit at offset
      // Format: GETBIT key offset
      if (parsed.length >= 3) {
        const key = parsed[1];
        const offset = parseInt(parsed[2]);
        
        // Validate offset
        if (offset < 0) {
          connection.write("-ERR bit offset is not an integer or out of range\r\n");
          return;
        }
        
        const storedValue = store.get(key);
        
        if (!storedValue) {
          // Key doesn't exist - return 0
          connection.write(encodeInteger(0));
          return;
        }
        
        const binaryData = Buffer.from(storedValue.value, 'binary');
        const byteIndex = Math.floor(offset / 8);
        
        // If offset is beyond string, return 0
        if (byteIndex >= binaryData.length) {
          connection.write(encodeInteger(0));
          return;
        }
        
        const bitIndex = 7 - (offset % 8); // MSB first
        const bit = (binaryData[byteIndex] >> bitIndex) & 1;
        
        connection.write(encodeInteger(bit));
      }
    } else if (command === "bitcount") {
      // BITCOUNT command - count set bits
      // Format: BITCOUNT key [start end]
      if (parsed.length >= 2) {
        const key = parsed[1];
        const storedValue = store.get(key);
        
        if (!storedValue) {
          // Key doesn't exist - return 0
          connection.write(encodeInteger(0));
          return;
        }
        
        const binaryData = Buffer.from(storedValue.value, 'binary');
        let start = 0;
        let end = binaryData.length - 1;
        
        // Parse optional start and end (byte offsets)
        if (parsed.length >= 4) {
          start = parseInt(parsed[2]);
          end = parseInt(parsed[3]);
          
          // Handle negative indexes
          if (start < 0) start = binaryData.length + start;
          if (end < 0) end = binaryData.length + end;
          
          // Clamp to valid range
          start = Math.max(0, Math.min(start, binaryData.length - 1));
          end = Math.max(0, Math.min(end, binaryData.length - 1));
        }
        
        // Count set bits in range
        let count = 0;
        for (let i = start; i <= end && i < binaryData.length; i++) {
          let byte = binaryData[i];
          // Brian Kernighan's algorithm to count set bits
          while (byte) {
            byte &= byte - 1;
            count++;
          }
        }
        
        connection.write(encodeInteger(count));
      }
    } else if (command === "bitpos") {
      // BITPOS command - find first bit with given value
      // Format: BITPOS key bit [start [end]]
      if (parsed.length >= 3) {
        const key = parsed[1];
        const bit = parseInt(parsed[2]);
        
        if (bit !== 0 && bit !== 1) {
          connection.write("-ERR bit is not an integer or out of range\r\n");
          return;
        }
        
        const storedValue = store.get(key);
        
        if (!storedValue) {
          // Key doesn't exist
          if (bit === 0) {
            connection.write(encodeInteger(0)); // First 0 bit is at position 0
          } else {
            connection.write(encodeInteger(-1)); // No 1 bits found
          }
          return;
        }
        
        const binaryData = Buffer.from(storedValue.value, 'binary');
        let start = 0;
        let end = binaryData.length - 1;
        
        // Parse optional start and end (byte offsets)
        if (parsed.length >= 4) {
          start = parseInt(parsed[3]);
          if (parsed.length >= 5) {
            end = parseInt(parsed[4]);
          }
          
          // Handle negative indexes
          if (start < 0) start = binaryData.length + start;
          if (end < 0) end = binaryData.length + end;
          
          // Clamp to valid range
          start = Math.max(0, Math.min(start, binaryData.length));
          end = Math.max(-1, Math.min(end, binaryData.length - 1));
        }
        
        // Find first bit with given value
        for (let byteIdx = start; byteIdx <= end && byteIdx < binaryData.length; byteIdx++) {
          const byte = binaryData[byteIdx];
          
          for (let bitIdx = 7; bitIdx >= 0; bitIdx--) {
            const currentBit = (byte >> bitIdx) & 1;
            if (currentBit === bit) {
              const position = byteIdx * 8 + (7 - bitIdx);
              connection.write(encodeInteger(position));
              return;
            }
          }
        }
        
        // Bit not found
        connection.write(encodeInteger(-1));
      }
    } else if (command === "bitop") {
      // BITOP command - perform bitwise operation
      // Format: BITOP operation destkey key [key ...]
      if (parsed.length >= 4) {
        const operation = parsed[1].toUpperCase();
        const destKey = parsed[2];
        const srcKeys = parsed.slice(3);
        
        if (!["AND", "OR", "XOR", "NOT"].includes(operation)) {
          connection.write("-ERR syntax error\r\n");
          return;
        }
        
        if (operation === "NOT" && srcKeys.length !== 1) {
          connection.write("-ERR BITOP NOT must have exactly one source key\r\n");
          return;
        }
        
        // Get all source values
        const sources: Buffer[] = [];
        let maxLength = 0;
        
        for (const srcKey of srcKeys) {
          const storedValue = store.get(srcKey);
          const buffer = storedValue ? Buffer.from(storedValue.value, 'binary') : Buffer.alloc(0);
          sources.push(buffer);
          maxLength = Math.max(maxLength, buffer.length);
        }
        
        // Perform operation
        const result = Buffer.alloc(maxLength);
        
        if (operation === "NOT") {
          for (let i = 0; i < sources[0].length; i++) {
            result[i] = ~sources[0][i];
          }
        } else {
          for (let i = 0; i < maxLength; i++) {
            let value = operation === "AND" ? 0xFF : 0x00;
            
            for (const source of sources) {
              const byte = i < source.length ? source[i] : 0;
              
              if (operation === "AND") {
                value &= byte;
              } else if (operation === "OR") {
                value |= byte;
              } else if (operation === "XOR") {
                value ^= byte;
              }
            }
            
            result[i] = value;
          }
        }
        
        // Store result
        store.set(destKey, {
          value: result.toString('binary')
        });
        
        incrementKeyVersion(destKey);
        appendToAOF(parsed);
        
        // Return length of result
        connection.write(encodeInteger(result.length));
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
        
        incrementKeyVersion(key); // Track modification for WATCH
        
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
        
        incrementKeyVersion(key); // Track modification for WATCH
        
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
          incrementKeyVersion(key); // Track modification for WATCH
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
          
          incrementKeyVersion(key); // Track modification for WATCH
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
    } else if (command === "type") {
      // TYPE requires one argument: key
      if (parsed.length >= 2) {
        const key = parsed[1];
        
        // Check if key exists in string store
        const storedValue = store.get(key);
        if (storedValue) {
          // Check if key has expired
          if (storedValue.expiresAt && Date.now() > storedValue.expiresAt) {
            // Key has expired, delete it and return none
            store.delete(key);
            connection.write("+none\r\n");
          } else {
            // Key is valid string
            connection.write("+string\r\n");
          }
        } else if (lists.has(key)) {
          // Key exists in lists
          connection.write("+list\r\n");
        } else if (streams.has(key)) {
          // Key exists in streams
          connection.write("+stream\r\n");
        } else if (sortedSets.has(key)) {
          // Key exists in sorted sets
          connection.write("+zset\r\n");
        } else if (sets.has(key)) {
          // Key exists in sets
          connection.write("+set\r\n");
        } else if (bloomFilters.has(key)) {
          // Key exists in bloom filters
          connection.write("+MBbloom--\r\n");
        } else {
          // Key doesn't exist
          connection.write("+none\r\n");
        }
      }
    } else if (command === "xadd") {
      // XADD requires at least 4 arguments: stream_key, entry_id, field1, value1, ...
      if (parsed.length >= 4) {
        const streamKey = parsed[1];
        let entryId = parsed[2];
        
        // Check if fully auto-generated ID (*)
        if (entryId === '*') {
          // Auto-generate both timestamp and sequence number
          // Get or create the stream
          let stream = streams.get(streamKey);
          if (!stream) {
            stream = [];
            streams.set(streamKey, stream);
          }
          
          // Get current Unix time in milliseconds
          const currentMsTime = Date.now();
          
          // Find last entry with same milliseconds time
          let lastSeqForTime = -1;
          for (let i = stream.length - 1; i >= 0; i--) {
            const existingIdParts = stream[i].id.split('-');
            const existingMsTime = parseInt(existingIdParts[0]);
            if (existingMsTime === currentMsTime) {
              lastSeqForTime = parseInt(existingIdParts[1]);
              break;
            } else if (existingMsTime < currentMsTime) {
              // Times are ordered, no need to search further
              break;
            }
          }
          
          // Determine sequence number
          const seqNum = (lastSeqForTime === -1) ? 0 : lastSeqForTime + 1;
          
          // Create the entry ID
          entryId = `${currentMsTime}-${seqNum}`;
        }
        
        // Parse entry ID into milliseconds and sequence number
        const idParts = entryId.split('-');
        if (idParts.length !== 2) {
          connection.write("-ERR Invalid stream ID specified as stream command argument\r\n");
          return;
        }
        
        const msTime = parseInt(idParts[0]);
        let seqNum: number;
        
        // Check if sequence number needs to be auto-generated
        if (idParts[1] === '*') {
          // Auto-generate sequence number
          // Get or create the stream
          let stream = streams.get(streamKey);
          if (!stream) {
            stream = [];
            streams.set(streamKey, stream);
          }
          
          // Find last entry with same milliseconds time
          let lastSeqForTime = -1;
          for (let i = stream.length - 1; i >= 0; i--) {
            const existingIdParts = stream[i].id.split('-');
            const existingMsTime = parseInt(existingIdParts[0]);
            if (existingMsTime === msTime) {
              lastSeqForTime = parseInt(existingIdParts[1]);
              break;
            } else if (existingMsTime < msTime) {
              // Times are ordered, no need to search further
              break;
            }
          }
          
          // Determine sequence number
          if (lastSeqForTime === -1) {
            // No entries with this time part exist
            if (msTime === 0) {
              seqNum = 1; // Special case: time=0 starts at 1
            } else {
              seqNum = 0; // Normal case: starts at 0
            }
          } else {
            // Entries exist, increment last sequence
            seqNum = lastSeqForTime + 1;
          }
          
          // Update entryId with generated sequence number
          entryId = `${msTime}-${seqNum}`;
        } else {
          seqNum = parseInt(idParts[1]);
        }
        
        // Check if ID is 0-0 (always invalid)
        if (msTime === 0 && seqNum === 0) {
          connection.write("-ERR The ID specified in XADD must be greater than 0-0\r\n");
          return;
        }
        
        // Get or create the stream
        let stream = streams.get(streamKey);
        if (!stream) {
          stream = [];
          streams.set(streamKey, stream);
        }
        
        // Validate ID if stream has entries
        if (stream.length > 0) {
          const lastEntry = stream[stream.length - 1];
          const lastIdParts = lastEntry.id.split('-');
          const lastMsTime = parseInt(lastIdParts[0]);
          const lastSeqNum = parseInt(lastIdParts[1]);
          
          // ID must be strictly greater than last entry's ID
          // Compare milliseconds time first
          if (msTime < lastMsTime) {
            connection.write("-ERR The ID specified in XADD is equal or smaller than the target stream top item\r\n");
            return;
          } else if (msTime === lastMsTime) {
            // If times are equal, sequence number must be greater
            if (seqNum <= lastSeqNum) {
              connection.write("-ERR The ID specified in XADD is equal or smaller than the target stream top item\r\n");
              return;
            }
          }
          // If msTime > lastMsTime, any sequence number is valid
        }
        
        // Parse field-value pairs
        const fields = new Map<string, string>();
        for (let i = 3; i < parsed.length; i += 2) {
          if (i + 1 < parsed.length) {
            const field = parsed[i];
            const value = parsed[i + 1];
            fields.set(field, value);
          }
        }
        
        // Create and add the entry
        const entry: StreamEntry = {
          id: entryId,
          fields: fields
        };
        stream.push(entry);
        
        incrementKeyVersion(streamKey); // Track modification for WATCH
        
        // Wake up any blocked XREAD clients waiting for this stream
        wakeUpBlockedXReadClients(streamKey);
        
        // Return the entry ID as a bulk string
        connection.write(encodeBulkString(entryId));
      }
    } else if (command === "xrange") {
      // XRANGE requires three arguments: stream_key, start_id, end_id
      if (parsed.length < 4) {
        connection.write("-ERR wrong number of arguments for 'xrange' command\r\n");
        return;
      }
      
      const streamKey = parsed[1];
      const startIdStr = parsed[2];
      const endIdStr = parsed[3];
      
      // Get the stream
      const stream = streams.get(streamKey);
      
      // If stream doesn't exist, return empty array
      if (!stream) {
        connection.write("*0\r\n");
        return;
      }
      
      // Parse start and end IDs
      // Special handling for '-' (minimum ID) and '+' (maximum ID)
      // If sequence number is not provided:
      // - For start ID, default to 0
      // - For end ID, default to max value (use large number)
      const startId = startIdStr === '-' 
        ? { msTime: 0, seqNum: 0 } 
        : parseStreamId(startIdStr, 0);
      const endId = endIdStr === '+' 
        ? { msTime: Number.MAX_SAFE_INTEGER, seqNum: Number.MAX_SAFE_INTEGER }
        : parseStreamId(endIdStr, Number.MAX_SAFE_INTEGER);
      
      // Filter entries within range (inclusive)
      const results: StreamEntry[] = [];
      for (const entry of stream) {
        const entryId = parseStreamId(entry.id, 0);
        
        // Check if entry is within range
        if (compareStreamIds(entryId, startId) >= 0 && compareStreamIds(entryId, endId) <= 0) {
          results.push(entry);
        }
      }
      
      // Encode response as RESP array of arrays
      // Format: [[id, [field1, value1, field2, value2]], ...]
      let response = `*${results.length}\r\n`;
      for (const entry of results) {
        // Each entry is an array of 2 elements: [id, fields_array]
        response += "*2\r\n";
        
        // Element 1: Entry ID as bulk string
        response += encodeBulkString(entry.id);
        
        // Element 2: Array of field-value pairs
        const fieldValues: string[] = [];
        for (const [field, value] of entry.fields) {
          fieldValues.push(field);
          fieldValues.push(value);
        }
        response += `*${fieldValues.length}\r\n`;
        for (const item of fieldValues) {
          response += encodeBulkString(item);
        }
      }
      
      connection.write(response);
    } else if (command === "xread") {
      // XREAD [BLOCK <milliseconds>] STREAMS <key1> <key2> ... <id1> <id2> ...
      
      // Check for BLOCK option
      let blockTimeout: number | null = null;
      let commandStart = 1;
      
      if (parsed.length > 2 && parsed[1].toLowerCase() === 'block') {
        blockTimeout = parseInt(parsed[2]);
        commandStart = 3;
      }
      
      // Find the STREAMS keyword
      let streamsIndex = -1;
      for (let i = commandStart; i < parsed.length; i++) {
        if (parsed[i].toLowerCase() === 'streams') {
          streamsIndex = i;
          break;
        }
      }
      
      if (streamsIndex === -1) {
        connection.write("-ERR wrong number of arguments for 'xread' command\r\n");
        return;
      }
      
      // Arguments after STREAMS: keys come first, then IDs
      const argsAfterStreams = parsed.slice(streamsIndex + 1);
      
      // Must have even number of args (N keys + N IDs)
      if (argsAfterStreams.length < 2 || argsAfterStreams.length % 2 !== 0) {
        connection.write("-ERR wrong number of arguments for 'xread' command\r\n");
        return;
      }
      
      const numStreams = argsAfterStreams.length / 2;
      const streamKeys = argsAfterStreams.slice(0, numStreams);
      const afterIds = argsAfterStreams.slice(numStreams);
      
      // Handle $ as special ID - replace with last entry ID in stream
      for (let i = 0; i < afterIds.length; i++) {
        if (afterIds[i] === '$') {
          const stream = streams.get(streamKeys[i]);
          if (stream && stream.length > 0) {
            // Use the last entry's ID
            afterIds[i] = stream[stream.length - 1].id;
          } else {
            // Stream is empty or doesn't exist, use "0-0"
            afterIds[i] = "0-0";
          }
        }
      }
      
      // Collect results for all streams
      const streamResults: Array<{ key: string; entries: StreamEntry[] }> = [];
      
      for (let i = 0; i < numStreams; i++) {
        const streamKey = streamKeys[i];
        const afterIdStr = afterIds[i];
        
        // Get the stream
        const stream = streams.get(streamKey);
        
        // If stream doesn't exist, skip it (don't include in results)
        if (!stream) {
          continue;
        }
        
        // Parse the ID to search after
        const afterId = parseStreamId(afterIdStr, 0);
        
        // Filter entries with ID > afterId (exclusive)
        const results: StreamEntry[] = [];
        for (const entry of stream) {
          const entryId = parseStreamId(entry.id, 0);
          
          // Check if entry ID is greater than afterId (exclusive)
          if (compareStreamIds(entryId, afterId) > 0) {
            results.push(entry);
          }
        }
        
        // Only include stream if it has results
        if (results.length > 0) {
          streamResults.push({ key: streamKey, entries: results });
        }
      }
      
      // If we have results, return immediately
      if (streamResults.length > 0) {
        // Encode response as RESP nested array
        // Format: [[stream_key, [[id, [field, value, ...]], ...]], ...]
        let response = `*${streamResults.length}\r\n`;
        
        for (const streamResult of streamResults) {
          // Stream element: [stream_key, entries_array]
          response += "*2\r\n";
          
          // Element 1: Stream key as bulk string
          response += encodeBulkString(streamResult.key);
          
          // Element 2: Array of entries
          response += `*${streamResult.entries.length}\r\n`;
          for (const entry of streamResult.entries) {
            // Each entry is [id, [field1, value1, ...]]
            response += "*2\r\n";
            
            // Entry ID
            response += encodeBulkString(entry.id);
            
            // Fields array
            const fieldValues: string[] = [];
            for (const [field, value] of entry.fields) {
              fieldValues.push(field);
              fieldValues.push(value);
            }
            response += `*${fieldValues.length}\r\n`;
            for (const item of fieldValues) {
              response += encodeBulkString(item);
            }
          }
        }
        
        connection.write(response);
        return;
      }
      
      // No results available
      // If BLOCK is not specified, return empty array
      if (blockTimeout === null) {
        connection.write("*0\r\n");
        return;
      }
      
      // Block the client
      const blockedClient: BlockedXReadClient = {
        socket: connection,
        streamKeys,
        afterIds,
        timestamp: Date.now()
      };
      
      // Set up timeout if non-zero
      if (blockTimeout > 0) {
        blockedClient.timeoutId = setTimeout(() => {
          // Remove from blocked list
          const index = blockedXReadClients.indexOf(blockedClient);
          if (index !== -1) {
            blockedXReadClients.splice(index, 1);
          }
          
          // Send null array response
          connection.write("*-1\r\n");
        }, blockTimeout);
      }
      
      blockedXReadClients.push(blockedClient);
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
  
  // Clean up transaction state when connection closes
  connection.on("close", () => {
    transactionState.delete(connection);
    queuedCommands.delete(connection);
    watchedKeys.delete(connection);
    watchedKeyVersions.delete(connection);
    subscriptions.delete(connection);
    authenticatedUser.delete(connection);
    protocolVersion.delete(connection);
    
    // Remove from replicas list if this was a replica connection
    const replicaIndex = replicas.indexOf(connection);
    if (replicaIndex !== -1) {
      replicas.splice(replicaIndex, 1);
      console.log(`Replica disconnected, total replicas: ${replicas.length}`);
    }
  });
});

const PORT = Number(process.env.PORT) || serverPort;

if (import.meta.main) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Redis server listening on port ${PORT} as ${serverRole}`);
  });
}

// If this is a replica, initiate handshake with master
if (serverRole === "slave" && masterHost && masterPort) {
  console.log(`Connecting to master at ${masterHost}:${masterPort}`);
  
  let handshakeStep = 0; // Track handshake progress
  let rdbReceived = false; // Track if RDB file has been fully received
  let dataBuffer = Buffer.alloc(0); // Buffer for accumulating data
  let replicaOffset = 0; // Track number of bytes processed
  
  const masterConnection = net.createConnection({
    host: masterHost,
    port: masterPort
  }, () => {
    console.log("Connected to master, sending PING");
    
    // Step 1: Send PING command as RESP array
    // *1\r\n$4\r\nPING\r\n
    masterConnection.write("*1\r\n$4\r\nPING\r\n");
    handshakeStep = 1;
  });
  
  masterConnection.on("error", (err: Error) => {
    console.error("Master connection error:", err);
  });
  
  masterConnection.on("data", (data: Buffer) => {
    dataBuffer = Buffer.concat([dataBuffer, data]);
    
    // Handle handshake responses
    if (handshakeStep === 1) {
      // Received PONG, send REPLCONF listening-port
      console.log("Received PONG, sending REPLCONF listening-port");
      
      const portStr = serverPort.toString();
      const replconfPort = `*3\r\n$8\r\nREPLCONF\r\n$14\r\nlistening-port\r\n$${portStr.length}\r\n${portStr}\r\n`;
      masterConnection.write(replconfPort);
      handshakeStep = 2;
      dataBuffer = Buffer.alloc(0);
      
    } else if (handshakeStep === 2) {
      // Received OK for listening-port, send REPLCONF capa psync2
      console.log("Received OK, sending REPLCONF capa psync2");
      
      masterConnection.write("*3\r\n$8\r\nREPLCONF\r\n$4\r\ncapa\r\n$6\r\npsync2\r\n");
      handshakeStep = 3;
      dataBuffer = Buffer.alloc(0);
      
    } else if (handshakeStep === 3) {
      // Received OK for capa psync2, send PSYNC
      console.log("Received OK, sending PSYNC ? -1");
      
      masterConnection.write("*3\r\n$5\r\nPSYNC\r\n$1\r\n?\r\n$2\r\n-1\r\n");
      handshakeStep = 4;
      dataBuffer = Buffer.alloc(0);
      
    } else if (handshakeStep === 4 && !rdbReceived) {
      // Received FULLRESYNC and RDB file
      const bufferStr = dataBuffer.toString();
      
      // Check if we have the FULLRESYNC response
      if (bufferStr.includes("FULLRESYNC")) {
        console.log("Received FULLRESYNC");
        
        // Find the RDB file marker ($<length>\r\n)
        const rdbMarkerIndex = bufferStr.indexOf("\n$");
        if (rdbMarkerIndex !== -1) {
          // Parse RDB length
          const rdbStart = rdbMarkerIndex + 2; // Skip \n$
          const rdbLengthEnd = bufferStr.indexOf("\r\n", rdbStart);
          
          if (rdbLengthEnd !== -1) {
            const rdbLength = parseInt(bufferStr.substring(rdbStart, rdbLengthEnd));
            const rdbContentStart = rdbLengthEnd + 2; // Skip \r\n
            
            // Check if we have the full RDB file
            if (dataBuffer.length >= rdbContentStart + rdbLength) {
              console.log(`RDB file received (${rdbLength} bytes)`);
              rdbReceived = true;
              handshakeStep = 5;
              
              // Remove everything up to and including the RDB file
              dataBuffer = dataBuffer.slice(rdbContentStart + rdbLength);
            }
          }
        }
      }
      
    }
    
    // Process propagated commands (not else-if so it can execute after RDB processing)
    if (handshakeStep === 5 && rdbReceived) {
      while (dataBuffer.length > 0) {
        const parsed = parseRESP(dataBuffer);
        
        if (!parsed || parsed.length === 0) {
          // Not enough data for a complete command, wait for more
          break;
        }
        
        // Process the command
        const command = parsed[0].toLowerCase();
        console.log(`Processing propagated command: ${command}`);
        
        // Handle REPLCONF GETACK - this is the only command that requires a response
        if (command === "replconf" && parsed.length >= 2 && parsed[1].toLowerCase() === "getack") {
          console.log(`Received REPLCONF GETACK, responding with ACK ${replicaOffset}`);
          // Respond with REPLCONF ACK <offset> as RESP array
          const offsetStr = replicaOffset.toString();
          const response = `*3\r\n$8\r\nREPLCONF\r\n$3\r\nACK\r\n$${offsetStr.length}\r\n${offsetStr}\r\n`;
          masterConnection.write(response);
        } else if (command === "set") {
          if (parsed.length >= 3) {
            const key = parsed[1];
            const value = parsed[2];
            
            let expiresAt: number | undefined = undefined;
            for (let i = 3; i < parsed.length; i += 2) {
              const option = parsed[i]?.toLowerCase();
              const optionValue = parsed[i + 1];
              
              if (option === "px" && optionValue) {
                const milliseconds = parseInt(optionValue);
                expiresAt = Date.now() + milliseconds;
              } else if (option === "ex" && optionValue) {
                const seconds = parseInt(optionValue);
                expiresAt = Date.now() + (seconds * 1000);
              }
            }
            
            store.set(key, { value, expiresAt });
            incrementKeyVersion(key); // Track modification for WATCH
            console.log(`SET ${key} = ${value}`);
          }
        }
        
        // Remove the processed command from buffer
        // We need to calculate how many bytes were consumed
        const bufferStr = dataBuffer.toString();
        const firstArrayEnd = bufferStr.indexOf("\r\n");
        if (firstArrayEnd === -1) break;
        
        const numElements = parseInt(bufferStr.substring(1, firstArrayEnd));
        let consumed = firstArrayEnd + 2;
        
        for (let i = 0; i < numElements; i++) {
          // Find bulk string length
          const bulkStart = bufferStr.indexOf("$", consumed);
          if (bulkStart === -1) break;
          const bulkLengthEnd = bufferStr.indexOf("\r\n", bulkStart);
          if (bulkLengthEnd === -1) break;
          
          const bulkLength = parseInt(bufferStr.substring(bulkStart + 1, bulkLengthEnd));
          consumed = bulkLengthEnd + 2 + bulkLength + 2; // +2 for \r\n after content
        }
        
        // Update replica offset with the bytes consumed
        replicaOffset += consumed;
        console.log(`Updated replica offset: ${replicaOffset} (consumed ${consumed} bytes)`);
        
        dataBuffer = dataBuffer.slice(consumed);
      }
    }
  });
}
