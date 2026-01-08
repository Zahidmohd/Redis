# RESP3 Implementation

## Overview

This Redis server now supports **RESP3** (Redis Serialization Protocol version 3), the latest version of Redis's protocol. RESP3 adds new data types, improved semantics, and better client-server communication.

## What is RESP3?

RESP3 is an evolution of RESP2 that adds:
- **New data types**: Map, Set, Boolean, Double, Null, Big Number
- **Better semantics**: Distinguishes between different null types
- **Protocol negotiation**: Clients can choose RESP2 or RESP3 via the HELLO command
- **Backward compatibility**: All RESP2 commands still work

## Key Features Implemented

### 1. Protocol Version Tracking

Each client connection tracks its protocol version:
- **Default**: RESP2 (version 2)
- **After HELLO 3**: RESP3 (version 3)

### 2. HELLO Command

The `HELLO` command negotiates protocol version and provides connection information.

**Syntax:**
```
HELLO [protover] [AUTH username password] [SETNAME clientname]
```

**Examples:**

#### Upgrade to RESP3
```bash
HELLO 3
```

**RESP3 Response (Map type):**
```
%7
$6
server
$5
redis
$7
version
$5
7.2.0
$5
proto
$1
3
$2
id
$1
1
$4
mode
$10
standalone
$4
role
$6
master
$7
modules
$0

```

#### RESP2 (default)
```bash
HELLO 2
```

**RESP2 Response (Array type):**
```
*14
$6
server
$5
redis
$7
version
$5
7.2.0
$5
proto
$1
2
$2
id
$1
1
$4
mode
$10
standalone
$4
role
$6
master
$7
modules
$0

```

#### With Authentication
```bash
HELLO 3 AUTH myuser mypassword
```

### 3. New RESP3 Data Types

#### Null (`_\r\n`)
RESP3 uses a dedicated null type instead of RESP2's null bulk string (`$-1\r\n`).

**Commands that return RESP3 null:**
- `GET` (when key doesn't exist)
- `ZRANK` (when member doesn't exist)
- `ZSCORE` (when member doesn't exist)
- `GEODIST` (when location doesn't exist)
- `EXEC` (when transaction aborted by WATCH)

**Example:**
```bash
# RESP2
GET nonexistent
$-1

# RESP3
GET nonexistent
_
```

#### Boolean (`#t\r\n` or `#f\r\n`)
RESP3 has native boolean type.

**Format:**
- True: `#t\r\n`
- False: `#f\r\n`

#### Map (`%<count>\r\n`)
RESP3 maps are key-value pairs, better than RESP2 arrays for representing hash data.

**Format:**
```
%<number_of_pairs>
<key1>
<value1>
<key2>
<value2>
...
```

**Used by:**
- `HELLO` command (in RESP3 mode)

#### Set (`~<count>\r\n`)
RESP3 sets represent unordered collections.

**Format:**
```
~<number_of_elements>
<element1>
<element2>
...
```

#### Double (`,<number>\r\n`)
RESP3 has a dedicated type for floating-point numbers.

**Format:**
```
,3.14159\r\n
```

## Implementation Details

### Protocol Version Storage

```typescript
// Track protocol version per connection
const protocolVersion = new Map<net.Socket, number>();

// Initialize to RESP2 (default)
protocolVersion.set(connection, 2);

// Upgrade to RESP3 via HELLO
protocolVersion.set(connection, 3);
```

### Encoding Functions

```typescript
// RESP3 Null
function encodeRESP3Null(): string {
  return "_\r\n";
}

// RESP3 Boolean
function encodeRESP3Boolean(value: boolean): string {
  return value ? "#t\r\n" : "#f\r\n";
}

// RESP3 Double
function encodeRESP3Double(num: number): string {
  return `,${num}\r\n`;
}

// RESP3 Map
function encodeRESP3Map(map: Map<string, string>): string {
  let result = `%${map.size}\r\n`;
  for (const [key, value] of map) {
    result += encodeBulkString(key);
    result += encodeBulkString(value);
  }
  return result;
}

// RESP3 Set
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
```

## Testing RESP3

### Using netcat (nc)

```bash
# Connect to Redis
nc localhost 6379

# Upgrade to RESP3
*1
$5
HELLO
$1
3

# Now all responses use RESP3 format
```

### Testing Protocol Negotiation

**Test 1: Default to RESP2**
```bash
*2
$3
GET
$7
missing

# Response: $-1\r\n (RESP2 null bulk string)
```

**Test 2: Upgrade to RESP3**
```bash
*2
$5
HELLO
$1
3

# Response: Map with server info (RESP3)

*2
$3
GET
$7
missing

# Response: _\r\n (RESP3 null)
```

**Test 3: HELLO with Authentication**
```bash
*4
$5
HELLO
$1
3
$4
AUTH
$7
myuser
$10
mypassword

# Authenticates AND upgrades to RESP3
```

## Commands Updated for RESP3

The following commands now return RESP3-specific types when the client is using RESP3:

- ✅ `HELLO` - Returns Map in RESP3, Array in RESP2
- ✅ `GET` - Returns RESP3 null when key doesn't exist
- ✅ `EXEC` - Returns RESP3 null when transaction aborted
- ✅ `ZRANK` - Returns RESP3 null when member doesn't exist
- ✅ `ZSCORE` - Returns RESP3 null when member doesn't exist
- ✅ `GEODIST` - Returns RESP3 null when location doesn't exist
- ✅ `ACL GETUSER` - Returns RESP3 null when user doesn't exist

## Backward Compatibility

✅ **Fully backward compatible!**

- All existing RESP2 clients continue to work
- Clients must explicitly upgrade to RESP3 using `HELLO 3`
- Default behavior is RESP2
- No breaking changes to existing commands

## Comparison: RESP2 vs RESP3

| Feature | RESP2 | RESP3 |
|---------|-------|-------|
| Null | `$-1\r\n` | `_\r\n` |
| Boolean | N/A (use integers) | `#t\r\n` / `#f\r\n` |
| Map | Array of pairs | `%<count>\r\n` |
| Set | Array | `~<count>\r\n` |
| Double | Bulk string | `,<num>\r\n` |
| HELLO response | Array | Map |

## Error Handling

### Unsupported Protocol Version

```bash
HELLO 999

# Response:
-NOPROTO unsupported protocol version
```

### Authentication Failure

```bash
HELLO 3 AUTH baduser badpass

# Response:
-WRONGPASS invalid username-password pair or user is disabled.
```

## Architecture

```
Client Connection
    |
    +-- Initialize: protocolVersion[socket] = 2 (RESP2)
    |
    +-- HELLO 3
    |       |
    |       +-- Validate version (2 or 3)
    |       +-- Handle AUTH if provided
    |       +-- Set: protocolVersion[socket] = 3
    |       +-- Return Map (RESP3) or Array (RESP2)
    |
    +-- GET missing_key
    |       |
    |       +-- Check: protocolVersion[socket]
    |       +-- If version == 3: return "_\r\n"
    |       +-- If version == 2: return "$-1\r\n"
    |
    +-- Close
            |
            +-- Cleanup: protocolVersion.delete(socket)
```

## Benefits of RESP3

1. **Type Safety**: Dedicated types for different data structures
2. **Better Semantics**: Distinguish between null, empty string, and missing values
3. **Efficiency**: Maps and Sets are more efficient than arrays
4. **Future-Proof**: Foundation for future protocol enhancements
5. **Backward Compatible**: Works alongside RESP2

## Real-World Usage

### Redis Client Libraries

Modern Redis clients (redis-cli, ioredis, redis-py) support RESP3:

```javascript
// Node.js with ioredis
const Redis = require('ioredis');
const redis = new Redis({
  protocol: 3  // Use RESP3
});

await redis.hello(3);
await redis.get('key');  // Returns RESP3 responses
```

### redis-cli

```bash
# Use RESP3
redis-cli --resp3

# Check protocol version
127.0.0.1:6379> HELLO
```

## Implementation Status

✅ **Completed Features:**
- Protocol version tracking per connection
- HELLO command with version negotiation
- HELLO with AUTH support
- RESP3 encoding functions (Null, Boolean, Double, Map, Set)
- Updated commands to return RESP3 types
- Backward compatibility with RESP2
- Automatic cleanup on connection close

## References

- [Redis RESP3 Specification](https://github.com/redis/redis-specifications/blob/master/protocol/RESP3.md)
- [HELLO Command Documentation](https://redis.io/commands/hello/)
- [Redis Protocol Evolution](https://redis.io/topics/protocol)

## Summary

Your Redis server now supports RESP3, giving clients access to modern protocol features while maintaining full backward compatibility with RESP2. Clients can upgrade using the `HELLO` command and enjoy better type semantics, improved efficiency, and future-proof communication.

