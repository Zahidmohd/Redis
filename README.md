# 🚀 Redis Server Implementation in TypeScript

[![progress-banner](https://backend.codecrafters.io/progress/redis/b83c8347-2e4d-48a7-992b-de64682ab78b)](https://app.codecrafters.io/users/codecrafters-bot?r=2qF)

A fully-featured Redis server clone built from scratch in TypeScript using Bun runtime. This implementation supports the Redis Serialization Protocol (RESP2/RESP3) and includes advanced features like optimistic locking, Bloom filters, Lua scripting, and more.

## ✨ Features

### Core Data Types
- **Strings**: SET, GET, INCR, DECR with expiry support (PX, EXAT)
- **Lists**: RPUSH, LPUSH, LPOP, LRANGE, LLEN, BLPOP (blocking operations)
- **Sets**: SADD, SMEMBERS, SISMEMBER, SREM, SCARD, SINTER, SUNION, SDIFF
- **Hashes**: HSET, HGET, HGETALL, HDEL, HEXISTS, HKEYS, HVALS, HLEN, HINCRBY, HINCRBYFLOAT, HMGET, HSETNX
- **Sorted Sets**: ZADD, ZRANK, ZRANGE, ZCARD, ZSCORE, ZREM with score-based ordering
- **Streams**: XADD, XRANGE, XREAD (with blocking and $ support)
- **Bloom Filters**: BF.RESERVE, BF.ADD, BF.EXISTS, BF.MADD, BF.MEXISTS, BF.INFO

### Advanced Features

#### 🔐 Optimistic Locking (WATCH/MULTI/EXEC)
Implements Redis optimistic locking with key versioning:
- `WATCH key [key ...]` - Monitor keys for changes
- `MULTI` - Start transaction
- `EXEC` - Execute transaction (fails if watched keys changed)
- `UNWATCH` - Clear all watched keys
- `DISCARD` - Abandon transaction

#### 🌐 RESP3 Protocol Support
Full support for RESP3 with new data types:
- Null type: `_\r\n`
- Boolean type: `#t\r\n` / `#f\r\n`
- Double type: `,3.14\r\n`
- Map type: `%2\r\n...\r\n`
- Set type: `~3\r\n...\r\n`
- Protocol negotiation via `HELLO` command

#### 🌍 Geospatial Commands
Full geospatial support with geohash encoding:
- `GEOADD` - Add locations with coordinates
- `GEOPOS` - Get position of members
- `GEODIST` - Calculate distance between points
- `GEOSEARCH` - Search by radius or box
- Haversine formula for distance calculation
- 52-bit geohash encoding (matches Redis)

#### 💾 Persistence

**RDB (Redis Database File)**
- Automatic loading on startup
- Support for Redis 9 format
- Configurable directory and filename
- Type-aware restoration

**AOF (Append Only File)**
- Write-ahead logging for durability
- Three fsync policies: `always`, `everysec`, `no`
- `BGREWRITEAOF` for compaction
- Automatic replay on startup

#### 🔒 Access Control Lists (ACL)
User authentication and authorization:
- `AUTH username password` - Authenticate
- `ACL WHOAMI` - Get current user
- `ACL GETUSER username` - Get user info
- `ACL SETUSER` - Create/modify users
- Per-user command permissions

#### 📡 Pub/Sub Messaging
Full publish/subscribe support:
- `SUBSCRIBE channel [channel ...]`
- `UNSUBSCRIBE [channel ...]`
- `PUBLISH channel message`
- Multi-channel subscriptions
- Message broadcasting

#### 🔄 Replication
Master-replica replication:
- `REPLCONF` - Replica configuration
- `PSYNC` - Partial synchronization
- RDB snapshot transfer
- Command propagation

#### 🎭 Transactions
Transaction support with error handling:
- `MULTI` - Start transaction
- `EXEC` - Execute queued commands
- `DISCARD` - Cancel transaction
- Atomic execution
- Error rollback

#### 🧮 Lua Scripting
Execute Lua scripts on the server:
- `EVAL script numkeys key [key ...] arg [arg ...]`
- `EVALSHA sha1 numkeys key [key ...] arg [arg ...]`
- `SCRIPT LOAD script` - Cache scripts
- `SCRIPT EXISTS sha1 [sha1 ...]`
- `SCRIPT FLUSH` - Clear script cache
- Support for `redis.call()` in scripts
- SHA1-based script caching

#### 📋 Command Introspection
Discover available commands programmatically:
- `COMMAND` - List all commands with metadata
- `COMMAND INFO command [command ...]` - Get command details
- `COMMAND COUNT` - Count total commands
- `COMMAND LIST` - List command names
- `COMMAND DOCS command [command ...]` - Get documentation

### Generic Commands
- `PING [message]` - Test connection
- `ECHO message` - Echo message back
- `TYPE key` - Get key type
- `EXISTS key [key ...]` - Check key existence
- `DEL key [key ...]` - Delete keys
- `KEYS pattern` - Find keys by pattern
- `CONFIG GET parameter` - Get config
- `CONFIG SET parameter value` - Set config
- `INFO [section]` - Server information

## 🏗️ Architecture

### Key Components

#### RESP Parser
Parses both RESP2 and RESP3 protocol messages:
- Array parsing (`*`)
- Bulk string parsing (`$`)
- Integer parsing (`:`)
- Error handling (`-`)

#### Protocol Version Management
Per-connection protocol tracking:
- RESP2 by default
- Upgrade via `HELLO` command
- Backward compatible responses

#### Data Storage
- `Map<string, StoredValue>` - Key-value store
- `Map<string, string[]>` - Lists
- `Map<string, Set<string>>` - Sets
- `Map<string, Map<string, string>>` - Hashes
- `Map<string, { score: number, member: string }[]>` - Sorted Sets
- `Map<string, BloomFilter>` - Bloom Filters
- `Map<string, { id: string, entries: Map<string, string> }[]>` - Streams

#### Key Versioning System
Optimistic locking implementation:
- Per-key version counters
- Watch tracking per connection
- Automatic version increments on writes
- Transaction validation

#### Bloom Filter Implementation
Space-efficient probabilistic data structure:
- Configurable capacity and error rate
- FNV-1a hash function
- Bit array storage
- No false negatives guaranteed

#### AOF Manager
Append-only file persistence:
- Command logging
- Configurable fsync policies
- Automatic replay
- Background rewrite

## 🚀 Getting Started

### Prerequisites
- [Bun](https://bun.sh) 1.2 or higher
- Git

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd codecrafters-redis-typescript
```

2. Install dependencies:
```bash
bun install
```

### Running the Server

#### Development Mode
```bash
bun run dev
```

#### Using the CodeCrafters Script
```bash
./your_program.sh
```

#### Manual Execution
```bash
bun run app/main.ts
```

The server will start on `127.0.0.1:6379` by default.

### Configuration

The server supports configuration via command-line arguments:

```bash
bun run app/main.ts --dir /tmp/redis-data --dbfilename dump.rdb --port 6380
```

Available options:
- `--dir <path>` - RDB file directory (default: `/tmp/redis-data`)
- `--dbfilename <name>` - RDB filename (default: `dump.rdb`)
- `--port <number>` - Server port (default: `6379`)
- `--replicaof <master_host> <master_port>` - Run as replica

### Environment Variables

- `PORT` - Override the default port (useful for deployment)

## 📝 Usage Examples

### Basic Commands
```bash
# String operations
redis-cli SET mykey "Hello, Redis!"
redis-cli GET mykey
redis-cli SET counter 0
redis-cli INCR counter

# Lists
redis-cli RPUSH mylist "item1" "item2" "item3"
redis-cli LRANGE mylist 0 -1
redis-cli LPOP mylist

# Sets
redis-cli SADD myset "apple" "banana" "orange"
redis-cli SMEMBERS myset
redis-cli SISMEMBER myset "apple"

# Hashes
redis-cli HSET user:1 name "John" age "30"
redis-cli HGET user:1 name
redis-cli HGETALL user:1

# Sorted Sets
redis-cli ZADD leaderboard 100 "player1" 200 "player2"
redis-cli ZRANK leaderboard "player1"
redis-cli ZRANGE leaderboard 0 -1
```

### Optimistic Locking
```bash
# Client 1: Start watching a key
redis-cli WATCH balance
redis-cli MULTI
redis-cli INCR balance
redis-cli EXEC  # Succeeds if no one modified balance

# Client 2: Concurrent modification
redis-cli SET balance 1000  # This invalidates Client 1's watch
```

### RESP3 Protocol
```bash
# Upgrade to RESP3
redis-cli HELLO 3

# Get boolean responses
redis-cli HEXISTS myhash field1  # Returns #t or #f

# Get null responses
redis-cli GET nonexistent  # Returns _
```

### Geospatial
```bash
# Add locations
redis-cli GEOADD locations -122.27652 37.805186 "San Francisco"
redis-cli GEOADD locations -73.935242 40.730610 "New York"

# Get positions
redis-cli GEOPOS locations "San Francisco"

# Calculate distance
redis-cli GEODIST locations "San Francisco" "New York" km

# Search nearby
redis-cli GEOSEARCH locations FROMLONLAT -122.27652 37.805186 BYRADIUS 100 km
```

### Bloom Filters
```bash
# Create a Bloom filter
redis-cli BF.RESERVE myfilter 0.01 1000

# Add items
redis-cli BF.ADD myfilter "item1"
redis-cli BF.MADD myfilter "item2" "item3"

# Check existence
redis-cli BF.EXISTS myfilter "item1"  # Returns 1
redis-cli BF.EXISTS myfilter "item999"  # Returns 0

# Get info
redis-cli BF.INFO myfilter
```

### AOF Persistence
```bash
# Enable AOF
redis-cli CONFIG SET appendonly yes
redis-cli CONFIG SET appendfsync everysec

# Trigger rewrite
redis-cli BGREWRITEAOF
```

### Lua Scripting
```bash
# Execute inline script
redis-cli EVAL "return redis.call('GET', KEYS[1])" 1 mykey

# Atomic increment
redis-cli EVAL "local val = redis.call('GET', KEYS[1]); redis.call('SET', KEYS[1], val + ARGV[1]); return val + ARGV[1]" 1 counter 5

# Load and execute by SHA
redis-cli SCRIPT LOAD "return redis.call('GET', KEYS[1])"
# Returns: "a42059b356c875f0717db19a51f6aaca9ae659ea"
redis-cli EVALSHA a42059b356c875f0717db19a51f6aaca9ae659ea 1 mykey
```

### Command Discovery
```bash
# List all commands
redis-cli COMMAND COUNT

# Get command metadata
redis-cli COMMAND INFO GET SET

# List command names
redis-cli COMMAND LIST

# Get documentation
redis-cli COMMAND DOCS GET
```

### Pub/Sub
```bash
# Terminal 1: Subscribe
redis-cli SUBSCRIBE news sports

# Terminal 2: Publish
redis-cli PUBLISH news "Breaking news!"
redis-cli PUBLISH sports "Game on!"
```

### Streams
```bash
# Add entries
redis-cli XADD mystream * sensor-id 1234 temperature 19.8
redis-cli XADD mystream * sensor-id 5678 temperature 22.3

# Read entries
redis-cli XRANGE mystream - +
redis-cli XREAD STREAMS mystream 0

# Blocking read
redis-cli XREAD BLOCK 1000 STREAMS mystream $
```

## 🧪 Testing

### Manual Testing with netcat
```bash
# Start the server
bun run dev

# In another terminal
nc localhost 6379
*1
$4
PING
# Response: +PONG
```

### Testing with redis-cli
```bash
# If you have redis-cli installed
redis-cli -h 127.0.0.1 -p 6379 PING
```

### Testing Optimistic Locking
```bash
# Test concurrent modifications
bash test_concurrent_watch.sh
```

## 📁 Project Structure

```
.
├── app/
│   └── main.ts              # Main server implementation
├── doc/                     # Documentation folder
│   ├── RESP3_IMPLEMENTATION.md # RESP3 protocol docs
│   ├── BLOOM_FILTERS.md        # Bloom filters docs
│   ├── AOF_PERSISTENCE.md      # AOF persistence docs
│   ├── HASHES.md               # Hashes data type docs
│   ├── LUA_SCRIPTING.md        # Lua scripting docs
│   ├── COMMAND_METADATA.md     # Command introspection docs
│   └── FEATURES_SUMMARY.md     # Complete features summary
├── your_program.sh          # Entry point script
├── package.json             # Dependencies
├── bun.lockb               # Bun lockfile
├── tsconfig.json           # TypeScript configuration
├── .gitignore              # Git ignore rules
└── README.md               # This file
```

## 🛠️ Development

### Code Organization

The codebase is organized into logical sections:

1. **Protocol Layer**: RESP parsing and encoding
2. **Data Structures**: In-memory storage
3. **Persistence**: RDB and AOF handling
4. **Replication**: Master-replica sync
5. **Command Handlers**: Individual command implementations
6. **Transaction System**: MULTI/EXEC/WATCH
7. **Scripting Engine**: Lua script execution
8. **Pub/Sub**: Message broker
9. **ACL**: Authentication and authorization

### Adding New Commands

1. Add command metadata to `commandMetadata` map
2. Implement command handler in main command switch
3. Add AOF logging if it's a write command
4. Add key versioning if it modifies data
5. Update documentation

## 🔧 Troubleshooting

### Port Already in Use

On Windows:
```bash
# Find process using port 6379
netstat -ano | findstr :6379

# Kill the process
taskkill //F //PID <PID>
```

On Linux/Mac:
```bash
# Find and kill process
lsof -ti:6379 | xargs kill -9
```

### RDB Loading Issues

Ensure the RDB file path is correct:
- Default: `/tmp/redis-data/dump.rdb`
- Use forward slashes even on Windows
- Check file permissions

### AOF Replay Errors

If AOF replay fails:
1. Check file integrity
2. Use `BGREWRITEAOF` to compact
3. Disable AOF temporarily: `CONFIG SET appendonly no`

## 📚 Resources

- [Redis Protocol Specification](https://redis.io/docs/reference/protocol-spec/)
- [Redis Commands Reference](https://redis.io/commands/)
- [RESP3 Specification](https://github.com/redis/redis-specifications/blob/master/protocol/RESP3.md)
- [Redis RDB Format](https://github.com/sripathikrishnan/redis-rdb-tools/wiki/Redis-RDB-Dump-File-Format)
- [Bloom Filters Explained](https://redis.io/docs/stack/bloom/)
- [CodeCrafters Redis Challenge](https://codecrafters.io/challenges/redis)

## 🎯 Implementation Status

### ✅ Completed Features

- [x] Basic RESP protocol (PING, ECHO)
- [x] String commands (GET, SET, INCR, DECR)
- [x] Expiry support (PX, EXAT)
- [x] RDB persistence loading
- [x] Replication (REPLCONF, PSYNC)
- [x] Transactions (MULTI, EXEC, DISCARD)
- [x] Lists (RPUSH, LPUSH, LPOP, LRANGE, BLPOP)
- [x] Streams (XADD, XRANGE, XREAD)
- [x] Pub/Sub (SUBSCRIBE, PUBLISH)
- [x] Sorted Sets (ZADD, ZRANK, ZRANGE, etc.)
- [x] Geospatial commands (GEOADD, GEOPOS, GEODIST, GEOSEARCH)
- [x] ACL support (AUTH, ACL commands)
- [x] Optimistic locking (WATCH/MULTI/EXEC)
- [x] RESP3 protocol support
- [x] Set data type (SADD, SMEMBERS, etc.)
- [x] Bloom Filters (BF.* commands)
- [x] AOF persistence (append-only file)
- [x] Hash data type (HSET, HGET, etc.)
- [x] Lua scripting (EVAL, EVALSHA, SCRIPT)
- [x] Command introspection (COMMAND)

### 🔄 Known Limitations

- Lua scripts are simulated (not actual Lua VM)
- Limited script commands supported
- ACL rules are basic (no category-based permissions)
- No cluster support
- No Sentinel support

## 🤝 Contributing

This is a learning project from CodeCrafters. Feel free to:
- Report issues
- Suggest improvements
- Submit pull requests
- Share feedback

## 📄 License

This project is part of the CodeCrafters Redis challenge. See [CodeCrafters](https://codecrafters.io) for terms.

## 🙏 Acknowledgments

- Built as part of the [CodeCrafters](https://codecrafters.io) "Build Your Own Redis" challenge
- Implements Redis protocol specifications
- Uses Bun runtime for TypeScript execution
- Special thanks to the Redis team for excellent documentation

---

**Note**: This is an educational implementation for learning purposes. For production use, please use the official [Redis](https://redis.io) server.

## 📞 Support

For questions or issues:
1. Check the documentation files in the repository
2. Review the CodeCrafters challenge page
3. Open an issue on GitHub

Happy coding! 🚀
