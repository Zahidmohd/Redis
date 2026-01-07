# Redis Server Implementation in TypeScript

A fully-featured, production-ready Redis server implementation built from scratch using TypeScript and Bun. This project implements the Redis Serialization Protocol (RESP) and supports a comprehensive set of Redis commands including strings, lists, streams, sorted sets, geospatial queries, pub/sub, transactions, replication, persistence, and access control.

## 🌟 Features

### Core Functionality
- **RESP Protocol**: Full implementation of Redis Serialization Protocol (RESP2)
- **TCP Server**: Built on Node.js `net` module for robust networking
- **Concurrent Connections**: Handle multiple clients simultaneously
- **In-Memory Storage**: High-performance key-value store with multiple data types

### Supported Data Types
- **Strings**: SET, GET, ECHO, INCR
- **Lists**: RPUSH, LPUSH, LPOP, LLEN, LRANGE, BLPOP (with blocking)
- **Streams**: XADD, XRANGE, XREAD (with blocking support)
- **Sorted Sets**: ZADD, ZRANK, ZRANGE, ZCARD, ZSCORE, ZREM
- **Geospatial**: GEOADD, GEOPOS, GEODIST, GEOSEARCH

### Advanced Features
- **Key Expiry**: Automatic expiration with PX (milliseconds) and EX (seconds) options
- **Blocking Operations**: BLPOP and XREAD with timeout support
- **Transactions**: MULTI, EXEC, DISCARD with error handling
- **Pub/Sub**: SUBSCRIBE, UNSUBSCRIBE, PUBLISH with channel management
- **Replication**: Master-replica architecture with command propagation
- **RDB Persistence**: Load data from RDB files on startup
- **Access Control Lists (ACL)**: User authentication with SHA-256 password hashing
- **Geospatial Queries**: 52-bit geohash encoding with BigInt precision

## 🚀 Getting Started

### Prerequisites
- **Bun**: Runtime environment (v1.2.23 or higher)
- **Node.js**: For compatibility (v18 or higher)
- **TypeScript**: For development

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/yourusername/codecrafters-redis-typescript.git
cd codecrafters-redis-typescript
```

2. **Install dependencies**
```bash
bun install
```

3. **Run the server**
```bash
./your_program.sh
```

Or directly with Bun:
```bash
bun run app/main.ts
```

### Configuration Options

The server supports several command-line arguments:

```bash
bun run app/main.ts --port 6380 --dir /tmp/redis --dbfilename dump.rdb
```

**Available flags:**
- `--port <number>`: Custom server port (default: 6379)
- `--replicaof <host> <port>`: Configure as replica of a master server
- `--dir <path>`: Directory for RDB file storage
- `--dbfilename <filename>`: RDB filename to load on startup

## 📖 Usage Examples

### Basic String Operations

```bash
# Connect with redis-cli
redis-cli -p 6379

# Simple SET and GET
> SET mykey "Hello World"
OK

> GET mykey
"Hello World"

# Set with expiry (5000 milliseconds)
> SET tempkey "expires soon" PX 5000
OK

> GET tempkey
"expires soon"

# After 5 seconds...
> GET tempkey
(nil)

# Increment counter
> SET counter 100
OK

> INCR counter
(integer) 101
```

### Lists

```bash
# Push elements to a list
> RPUSH mylist "apple" "banana" "cherry"
(integer) 3

> LPUSH mylist "orange"
(integer) 4

# Get list length
> LLEN mylist
(integer) 4

# Retrieve range of elements
> LRANGE mylist 0 -1
1) "orange"
2) "apple"
3) "banana"
4) "cherry"

# Pop element from list
> LPOP mylist
"orange"

# Blocking pop (waits for element)
> BLPOP emptylist 5
(nil)  # Returns after 5 second timeout
```

### Streams

```bash
# Add entries to a stream
> XADD mystream * temperature 25.5 humidity 60
"1704672000000-0"

> XADD mystream * temperature 26.0 humidity 62
"1704672001000-0"

# Query stream entries
> XRANGE mystream - +
1) 1) "1704672000000-0"
   2) 1) "temperature"
      2) "25.5"
      3) "humidity"
      4) "60"
2) 1) "1704672001000-0"
   2) 1) "temperature"
      2) "26.0"
      3) "humidity"
      4) "62"

# Read new entries (blocking)
> XREAD BLOCK 5000 STREAMS mystream $
(waits for new entries, timeout after 5 seconds)
```

### Sorted Sets

```bash
# Add members to sorted set
> ZADD leaderboard 100 "player1"
(integer) 1

> ZADD leaderboard 95 "player2" 110 "player3"
(integer) 2

# Get rank of a member (0-based)
> ZRANK leaderboard "player1"
(integer) 1

# Get range of members
> ZRANGE leaderboard 0 -1
1) "player2"
2) "player1"
3) "player3"

# Get score
> ZSCORE leaderboard "player3"
"110"

# Count members
> ZCARD leaderboard
(integer) 3
```

### Geospatial Queries

```bash
# Add locations
> GEOADD cities 13.361389 38.115556 "Palermo"
(integer) 1

> GEOADD cities 15.087269 37.502669 "Catania"
(integer) 1

# Get coordinates
> GEOPOS cities "Palermo"
1) 1) "13.36138933897018433"
   2) "38.11555639549629859"

# Calculate distance (in meters)
> GEODIST cities "Palermo" "Catania"
"166274.1516"

# Search within radius
> GEOSEARCH cities FROMLONLAT 15 37 BYRADIUS 200 km
1) "Catania"
2) "Palermo"
```

### Pub/Sub

```bash
# Subscribe to a channel (Client 1)
> SUBSCRIBE news
1) "subscribe"
2) "news"
3) (integer) 1

# Publish message (Client 2)
> PUBLISH news "Breaking: Redis is awesome!"
(integer) 1

# Client 1 receives:
1) "message"
2) "news"
3) "Breaking: Redis is awesome!"
```

### Transactions

```bash
# Start transaction
> MULTI
OK

# Queue commands
> SET account1 100
QUEUED

> SET account2 200
QUEUED

> INCR account1
QUEUED

# Execute all at once
> EXEC
1) OK
2) OK
3) (integer) 101

# Or discard transaction
> MULTI
OK
> SET key value
QUEUED
> DISCARD
OK
```

### Access Control

```bash
# Check current user
> ACL WHOAMI
"default"

# Set password for default user
> ACL SETUSER default >mypassword
OK

# New connections now require authentication
# (in a new connection)
> PING
(error) NOAUTH Authentication required.

> AUTH default mypassword
OK

> PING
PONG
```

### Replication

**Start master server:**
```bash
bun run app/main.ts --port 6379
```

**Start replica servers:**
```bash
# Replica 1
bun run app/main.ts --port 6380 --replicaof localhost 6379

# Replica 2
bun run app/main.ts --port 6381 --replicaof localhost 6379
```

**Test replication:**
```bash
# On master (port 6379)
redis-cli -p 6379
> SET key "value from master"
OK

# On replica (port 6380)
redis-cli -p 6380
> GET key
"value from master"

# Check replication status
> INFO replication
role:slave
master_host:localhost
master_port:6379
```

**Wait for replication:**
```bash
# On master - wait for 2 replicas to acknowledge
> SET important "data"
OK

> WAIT 2 5000
(integer) 2  # 2 replicas acknowledged within 5 seconds
```

## 🏗️ Architecture

### Core Components

#### 1. RESP Protocol Parser
Implements full RESP2 parsing for:
- Simple Strings (`+OK\r\n`)
- Errors (`-ERR message\r\n`)
- Integers (`:100\r\n`)
- Bulk Strings (`$5\r\nhello\r\n`)
- Arrays (`*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n`)

#### 2. Data Storage

```typescript
// String storage with expiry
interface StoredValue {
  value: string;
  expiresAt?: number;
}
const store = new Map<string, StoredValue>();

// Lists
const lists = new Map<string, string[]>();

// Streams
interface StreamEntry {
  id: string;
  fields: Map<string, string>;
}
const streams = new Map<string, StreamEntry[]>();

// Sorted Sets
interface SortedSetMember {
  member: string;
  score: number;
}
const sortedSets = new Map<string, SortedSetMember[]>();

// Pub/Sub subscriptions
const subscriptions = new Map<net.Socket, Set<string>>();

// ACL users
interface User {
  flags: string[];
  passwords: string[];  // SHA-256 hashes
}
const users = new Map<string, User>();
const authenticatedUser = new Map<net.Socket, string | null>();
```

#### 3. Blocking Operations

Implemented using queues and timers:

```typescript
interface BlockedClient {
  connection: net.Socket;
  keys: string[];
  timeout: number;
  timestamp: number;
  timer?: NodeJS.Timeout;
}
const blockedClients: BlockedClient[] = [];
```

#### 4. Replication System

Master-replica architecture with:
- Handshake protocol (PING → REPLCONF → PSYNC)
- Empty RDB file transfer
- Command propagation
- Offset tracking for synchronization
- WAIT command for acknowledgement

#### 5. Geohash Algorithm

52-bit precision geohash encoding using BigInt:

```typescript
function encodeGeohash(longitude: number, latitude: number): number {
  // Normalize to 26-bit integers
  const normalizedLat = Math.pow(2, 26) * (latitude - MIN_LATITUDE) / LATITUDE_RANGE;
  const normalizedLon = Math.pow(2, 26) * (longitude - MIN_LONGITUDE) / LONGITUDE_RANGE;
  
  // Interleave bits for spatial locality
  return Number(interleaveBits(latInt, lonInt));
}
```

#### 6. Transaction System

Per-connection transaction state:

```typescript
const transactionState = new Map<net.Socket, boolean>();
const queuedCommands = new Map<net.Socket, string[][]>();
```

### Performance Characteristics

| Operation | Time Complexity | Space Complexity |
|-----------|-----------------|------------------|
| GET/SET | O(1) | O(1) |
| LPUSH/RPUSH | O(1) amortized | O(1) |
| LRANGE | O(N) where N = range size | O(N) |
| XADD | O(1) | O(1) |
| XRANGE | O(M) where M = results | O(M) |
| ZADD | O(log N) | O(1) |
| ZRANK | O(log N) | O(1) |
| ZRANGE | O(log N + M) | O(M) |
| GEOADD | O(log N) | O(1) |
| GEOSEARCH | O(N) | O(M) |
| AUTH | O(P) where P = passwords | O(1) |

## 🧪 Testing

The project has been tested against CodeCrafters' official test suite, passing all stages including:

- ✅ Basic TCP server and RESP protocol
- ✅ String operations with expiry
- ✅ List operations including blocking
- ✅ Stream operations with auto-generated IDs
- ✅ Sorted sets with score-based ordering
- ✅ Geospatial queries with accurate haversine distance
- ✅ Pub/Sub messaging
- ✅ Multi-command transactions
- ✅ Master-replica replication
- ✅ RDB file persistence
- ✅ ACL and authentication

### Run Tests Manually

```bash
# Test basic commands
redis-cli -p 6379 PING
# PONG

# Test SET/GET
redis-cli -p 6379 SET testkey testvalue
# OK
redis-cli -p 6379 GET testkey
# "testvalue"

# Test expiry
redis-cli -p 6379 SET expkey "expires" PX 1000
sleep 2
redis-cli -p 6379 GET expkey
# (nil)
```

## 🛠️ Implementation Details

### Key Technical Decisions

#### 1. BigInt for Geohash
JavaScript's bitwise operators work on 32-bit signed integers, which is insufficient for 52-bit geohashes. Solution: Use BigInt arithmetic for accurate bit manipulation.

```typescript
function interleaveBits(x: number, y: number): bigint {
  const xSpread = spread32BitsTo64Bits(x);
  const ySpread = spread32BitsTo64Bits(y);
  return xSpread | (ySpread << 1n);
}
```

#### 2. SHA-256 Password Hashing
Secure password storage using Node.js crypto module:

```typescript
import * as crypto from "crypto";

const hash = crypto.createHash("sha256").update(password).digest("hex");
```

#### 3. FIFO Queue for BLPOP
Ensures fairest client service (longest waiting client served first):

```typescript
// When element becomes available
const oldestClient = blockedClients.shift();
```

#### 4. Per-Connection State
Transactions, authentication, and subscriptions tracked per connection:

```typescript
const transactionState = new Map<net.Socket, boolean>();
const authenticatedUser = new Map<net.Socket, string | null>();
const subscriptions = new Map<net.Socket, Set<string>>();
```

#### 5. RDB File Format
Supports Redis RDB version 9 with opcodes:
- `0xFF`: End of file
- `0xFE`: Database selector
- `0xFB`: Hash table size info
- `0xFC`: Expiry in milliseconds (8 bytes, little-endian)
- `0xFD`: Expiry in seconds (4 bytes)
- `0x00`: String value type

### Error Handling

Comprehensive error messages for:
- Invalid commands: `-ERR unknown command 'INVALID'\r\n`
- Wrong argument count: `-ERR wrong number of arguments for 'GET' command\r\n`
- Type errors: `-WRONGTYPE Operation against a key holding the wrong kind of value\r\n`
- Authentication: `-NOAUTH Authentication required.\r\n`
- Invalid passwords: `-WRONGPASS invalid username-password pair\r\n`
- Transaction errors: `-ERR EXEC without MULTI\r\n`
- Geospatial: `-ERR invalid longitude\r\n`

## 📊 Command Reference

### String Commands
| Command | Syntax | Description |
|---------|--------|-------------|
| SET | `SET key value [PX milliseconds] [EX seconds]` | Set key with optional expiry |
| GET | `GET key` | Get value of key |
| ECHO | `ECHO message` | Echo the message |
| INCR | `INCR key` | Increment integer value |
| TYPE | `TYPE key` | Get data type of key |

### List Commands
| Command | Syntax | Description |
|---------|--------|-------------|
| RPUSH | `RPUSH key element [element ...]` | Push to right of list |
| LPUSH | `LPUSH key element [element ...]` | Push to left of list |
| LPOP | `LPOP key [count]` | Pop from left of list |
| LLEN | `LLEN key` | Get list length |
| LRANGE | `LRANGE key start stop` | Get range of elements |
| BLPOP | `BLPOP key [key ...] timeout` | Blocking pop |

### Stream Commands
| Command | Syntax | Description |
|---------|--------|-------------|
| XADD | `XADD key ID field value [field value ...]` | Add entry to stream |
| XRANGE | `XRANGE key start end` | Query stream range |
| XREAD | `XREAD [BLOCK ms] STREAMS key [key ...] ID [ID ...]` | Read from streams |

### Sorted Set Commands
| Command | Syntax | Description |
|---------|--------|-------------|
| ZADD | `ZADD key score member` | Add member to sorted set |
| ZRANK | `ZRANK key member` | Get rank of member |
| ZRANGE | `ZRANGE key start stop` | Get range of members |
| ZCARD | `ZCARD key` | Count members |
| ZSCORE | `ZSCORE key member` | Get score of member |
| ZREM | `ZREM key member` | Remove member |

### Geospatial Commands
| Command | Syntax | Description |
|---------|--------|-------------|
| GEOADD | `GEOADD key longitude latitude member` | Add location |
| GEOPOS | `GEOPOS key member [member ...]` | Get coordinates |
| GEODIST | `GEODIST key member1 member2 [unit]` | Calculate distance |
| GEOSEARCH | `GEOSEARCH key FROMLONLAT lon lat BYRADIUS radius unit` | Search radius |

### Pub/Sub Commands
| Command | Syntax | Description |
|---------|--------|-------------|
| SUBSCRIBE | `SUBSCRIBE channel [channel ...]` | Subscribe to channels |
| UNSUBSCRIBE | `UNSUBSCRIBE [channel [channel ...]]` | Unsubscribe from channels |
| PUBLISH | `PUBLISH channel message` | Publish message |

### Transaction Commands
| Command | Syntax | Description |
|---------|--------|-------------|
| MULTI | `MULTI` | Start transaction |
| EXEC | `EXEC` | Execute transaction |
| DISCARD | `DISCARD` | Discard transaction |

### ACL Commands
| Command | Syntax | Description |
|---------|--------|-------------|
| ACL WHOAMI | `ACL WHOAMI` | Get current username |
| ACL GETUSER | `ACL GETUSER username` | Get user properties |
| ACL SETUSER | `ACL SETUSER username >password` | Set user password |
| AUTH | `AUTH username password` | Authenticate connection |

### Server Commands
| Command | Syntax | Description |
|---------|--------|-------------|
| PING | `PING` | Test connection |
| INFO | `INFO replication` | Get server info |
| CONFIG GET | `CONFIG GET parameter` | Get config value |
| KEYS | `KEYS pattern` | List keys matching pattern |
| WAIT | `WAIT numreplicas timeout` | Wait for replicas |
| REPLCONF | `REPLCONF ...` | Replication config |
| PSYNC | `PSYNC replicationid offset` | Start replication |

## 🔧 Development

### Project Structure

```
codecrafters-redis-typescript/
├── app/
│   └── main.ts              # Main server implementation
├── package.json             # Dependencies and scripts
├── tsconfig.json            # TypeScript configuration
├── bun.lockb                # Bun lock file
├── your_program.sh          # Startup script
├── project_plan.md          # Detailed development log
└── README.md                # This file
```

### Building from Source

```bash
# Install dependencies
bun install

# Run development server with auto-reload
bun --watch app/main.ts

# Type checking
bun run tsc --noEmit
```

### Code Style

- **Indentation**: 2 spaces
- **Naming**: camelCase for variables, PascalCase for interfaces
- **Error Handling**: Explicit error messages matching Redis format
- **Comments**: Explain complex algorithms (geohash, replication)

## 🤝 Contributing

This is a learning project built as part of the CodeCrafters Redis challenge. Feel free to:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is open source and available under the MIT License.

## 🙏 Acknowledgments

- **CodeCrafters**: For the excellent Redis challenge and test suite
- **Redis**: For the comprehensive documentation and RDB format specification
- **Bun**: For the fast and modern JavaScript runtime
- **TypeScript**: For type safety and developer experience

## 📚 Resources

- [Redis Protocol Specification](https://redis.io/docs/reference/protocol-spec/)
- [Redis Commands](https://redis.io/commands/)
- [RDB File Format](https://github.com/sripathikrishnan/redis-rdb-tools/wiki/Redis-RDB-Dump-File-Format)
- [CodeCrafters Redis Challenge](https://codecrafters.io/challenges/redis)
- [Geohash Algorithm](https://en.wikipedia.org/wiki/Geohash)
- [Haversine Formula](https://en.wikipedia.org/wiki/Haversine_formula)

## 🐛 Known Issues

- Limited to RESP2 protocol (RESP3 not yet supported)
- RDB writing not implemented (read-only persistence)
- Cluster mode not supported
- Memory limits not enforced
- Some advanced ACL features (command permissions, key patterns) not implemented

## 🚧 Future Improvements

- [ ] RESP3 protocol support
- [ ] RDB file writing (SAVE, BGSAVE commands)
- [ ] AOF (Append-Only File) persistence
- [ ] Redis Cluster support
- [ ] Memory eviction policies (LRU, LFU)
- [ ] More geospatial commands (GEORADIUS, GEOHASH)
- [ ] Lua scripting support (EVAL, EVALSHA)
- [ ] HyperLogLog support
- [ ] Bitmaps and bitfield operations
- [ ] Advanced ACL with per-command permissions
- [ ] Performance optimizations
- [ ] Comprehensive benchmarking suite

---

**Built with ❤️ using TypeScript and Bun**

For questions or feedback, please open an issue or reach out!
