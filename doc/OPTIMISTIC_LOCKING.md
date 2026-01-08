# Redis Optimistic Locking Implementation

## Overview

This Redis server implements **optimistic locking** using the `WATCH`, `MULTI`, and `EXEC` commands. This allows multiple clients to coordinate access to shared data without using traditional locks.

## How It Works

### Key Concepts

1. **WATCH**: Marks keys to be watched for modifications
2. **MULTI**: Starts a transaction and snapshots the watched key versions
3. **EXEC**: Executes the transaction only if watched keys haven't changed
4. **Key Versioning**: Each key has an internal version number that increments on modification

### Implementation Details

- **Data Structures**:
  - `watchedKeys: Map<Socket, Set<string>>` - Tracks which keys each client is watching
  - `watchedKeyVersions: Map<Socket, Map<string, number>>` - Snapshots key versions when MULTI is called
  - `keyVersions: Map<string, number>` - Tracks the current version of each key

- **Write Commands that Increment Key Versions**:
  - `SET`, `INCR`, `DECR`
  - `RPUSH`, `LPUSH`, `LPOP`, `RPOP`
  - `XADD` (streams)
  - `ZADD`, `ZREM` (sorted sets)
  - `GEOADD` (geospatial)

## Commands

### WATCH key [key ...]

Marks one or more keys to watch for modifications.

```redis
WATCH mykey
WATCH key1 key2 key3
```

**Returns**: `+OK`

### UNWATCH

Removes all watched keys for the current connection.

```redis
UNWATCH
```

**Returns**: `+OK`

### MULTI + EXEC with WATCH

When `MULTI` is called after `WATCH`, the current versions of all watched keys are snapshot. When `EXEC` is called, these versions are compared:

- If **no changes**: Transaction executes normally
- If **any changes**: Transaction is **aborted** and `$-1\r\n` (null) is returned

## Usage Examples

### Example 1: Successful Transaction (No Conflict)

```redis
127.0.0.1:6379> SET balance 100
OK
127.0.0.1:6379> WATCH balance
OK
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> INCR balance
QUEUED
127.0.0.1:6379> EXEC
1) (integer) 101
127.0.0.1:6379> GET balance
"101"
```

### Example 2: Failed Transaction (Race Condition Detected)

**Client 1:**
```redis
127.0.0.1:6379> SET counter 0
OK
127.0.0.1:6379> WATCH counter
OK
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> INCR counter
QUEUED
```

**Client 2 (interferes):**
```redis
127.0.0.1:6379> SET counter 999
OK
```

**Client 1 (continues):**
```redis
127.0.0.1:6379> EXEC
(nil)  # Transaction aborted!
127.0.0.1:6379> GET counter
"999"  # Client 2's value, not 1
```

### Example 3: UNWATCH Clears Watched Keys

```redis
127.0.0.1:6379> SET mykey 100
OK
127.0.0.1:6379> WATCH mykey
OK
127.0.0.1:6379> UNWATCH
OK
# Now mykey is no longer watched
127.0.0.1:6379> SET mykey 200  # This won't affect the next transaction
OK
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> INCR mykey
QUEUED
127.0.0.1:6379> EXEC
1) (integer) 201  # Success!
```

### Example 4: DISCARD Clears WATCH

```redis
127.0.0.1:6379> SET value 50
OK
127.0.0.1:6379> WATCH value
OK
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> INCR value
QUEUED
127.0.0.1:6379> DISCARD  # Aborts transaction AND clears watch
OK
# Now value is no longer watched
127.0.0.1:6379> SET value 999
OK
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> INCR value
QUEUED
127.0.0.1:6379> EXEC
1) (integer) 1000  # Success!
```

## Real-World Use Case: Inventory Management

This pattern prevents overselling when multiple buyers try to purchase the last item simultaneously.

**Scenario**: 1 item in stock, 2 buyers trying to purchase at the same time

**Buyer 1:**
```redis
WATCH inventory
GET inventory    # Returns: 1
# Check if > 0, then proceed
MULTI
DECR inventory
EXEC             # Success! Returns array
GET inventory    # 0
```

**Buyer 2 (at the same time):**
```redis
WATCH inventory
GET inventory    # Returns: 1
# Check if > 0, then proceed
MULTI
DECR inventory
EXEC             # Aborted! Returns (nil)
GET inventory    # Still 0, transaction was rejected
```

**Result**: Only one buyer's transaction succeeds, preventing inventory from going negative!

## Testing the Implementation

### Manual Testing with Two Terminals

**Terminal 1:**
```bash
nc localhost 6379
*3
$3
SET
$7
counter
$1
0

*2
$5
WATCH
$7
counter

*1
$5
MULTI

*2
$4
INCR
$7
counter

# Wait for Terminal 2 to modify counter
# Then execute:
*1
$4
EXEC
# Should return: $-1 (nil) - transaction aborted
```

**Terminal 2 (while Terminal 1 is waiting):**
```bash
nc localhost 6379
*3
$3
SET
$7
counter
$3
999
```

### Key Features Implemented

✅ **WATCH command** - Marks keys for optimistic locking  
✅ **UNWATCH command** - Clears all watched keys  
✅ **MULTI integration** - Snapshots key versions when transaction starts  
✅ **EXEC validation** - Aborts transaction if watched keys changed  
✅ **DISCARD cleanup** - Clears watched keys when transaction is discarded  
✅ **Multi-key watching** - Can watch multiple keys simultaneously  
✅ **Connection cleanup** - Watched keys are cleared when client disconnects  
✅ **Version tracking** - All write operations increment key versions  

### Advanced Features

- **Per-connection isolation**: Each client has its own watched key set
- **Atomic version checking**: All watched keys are checked atomically before EXEC
- **Automatic cleanup**: Watched keys are cleared after EXEC or connection close
- **Multi-key support**: Can watch any number of keys simultaneously
- **Cross-data-type support**: Works with strings, lists, streams, sorted sets, etc.

## Architecture

```
Client Connection
    |
    +-- WATCH key1 key2
    |       |
    |       +-- Store: watchedKeys[socket] = {key1, key2}
    |
    +-- MULTI
    |       |
    |       +-- Snapshot: watchedKeyVersions[socket] = {key1: v1, key2: v2}
    |
    +-- INCR key1 (queued)
    |
    +-- External Client: SET key1 999
    |                        |
    |                        +-- keyVersions[key1]++ (v1 → v2)
    |
    +-- EXEC
            |
            +-- Compare versions:
            |     watchedKeyVersions[socket][key1] (v1) != keyVersions[key1] (v2)
            |
            +-- ABORT: Return (nil)
            +-- Clear: watchedKeys, watchedKeyVersions
```

## Performance Considerations

- **No blocking**: Unlike `BLPOP`, `WATCH` doesn't block the client
- **Memory efficient**: Only stores key names and integer versions
- **Scalable**: Version checking is O(n) where n = number of watched keys
- **Automatic cleanup**: No memory leaks from disconnected clients

## Comparison with Traditional Locking

| Feature | Optimistic (WATCH) | Pessimistic (Lock) |
|---------|-------------------|-------------------|
| Blocks other clients | No | Yes |
| Retry on conflict | Client must retry | Waits automatically |
| Best for | Low contention | High contention |
| Deadlock risk | No | Yes |
| Implementation | This server | Not implemented |

## Related Commands

- `MULTI` - Start transaction
- `EXEC` - Execute transaction  
- `DISCARD` - Abort transaction
- `UNWATCH` - Clear watched keys

## References

- [Redis Transactions](https://redis.io/topics/transactions)
- [Optimistic Locking with WATCH](https://redis.io/commands/watch)
- [CAS (Compare-And-Swap)](https://en.wikipedia.org/wiki/Compare-and-swap)

