# Redis Bloom Filters Implementation

## Overview

This Redis server now supports **Bloom Filters** - a space-efficient probabilistic data structure that can test whether an element is a member of a set. Bloom filters can return **false positives** but **never false negatives**.

## What is a Bloom Filter?

A Bloom Filter is a probabilistic data structure that:
- ✅ Can tell you definitively that an element is **NOT** in the set
- ⚠️ Can tell you an element **MIGHT** be in the set (false positives possible)
- 📦 Uses much less memory than storing actual elements
- ⚡ Has O(k) time complexity where k = number of hash functions (constant time)

### Key Characteristics

- **No false negatives**: If it says an item is NOT there, it's definitely not there
- **Possible false positives**: If it says an item IS there, it might be (probability depends on error rate)
- **Cannot remove items**: Once added, items cannot be removed (standard bloom filters)
- **Space efficient**: Uses bits instead of storing actual data

## Implementation Details

### BloomFilter Class

```typescript
class BloomFilter {
  private bitArray: Uint8Array;        // Bit array for storing bloom filter data
  private capacity: number;             // Maximum expected number of items
  private errorRate: number;            // Desired false positive rate
  private numBits: number;              // Total number of bits in array
  private numHashes: number;            // Number of hash functions to use
  private itemCount: number;            // Number of items added
}
```

### Mathematical Formulas

1. **Optimal number of bits**: `m = -(n * ln(p)) / (ln(2)^2)`
   - `n` = capacity (expected number of items)
   - `p` = error rate (false positive probability)
   - `m` = number of bits needed

2. **Optimal number of hash functions**: `k = (m/n) * ln(2)`
   - `k` = number of hash functions

### Hash Function

Uses **FNV-1a** (Fowler-Noll-Vo) hash algorithm with multiple seeds to generate independent hash values:

```typescript
hash = 2166136261 ^ seed  // FNV offset basis
for each character:
  hash ^= charCode
  hash *= 16777619        // FNV prime
return hash % numBits
```

## Commands

### BF.RESERVE

Create a new bloom filter with custom parameters.

**Syntax:**
```
BF.RESERVE key error_rate capacity
```

**Parameters:**
- `key`: Name of the bloom filter
- `error_rate`: Desired false positive rate (0 < rate < 1)
- `capacity`: Expected number of items

**Returns:** `+OK` or error

**Examples:**
```bash
# Create bloom filter for 10,000 items with 0.1% error rate
BF.RESERVE myfilter 0.001 10000
# Returns: +OK

# Error if already exists
BF.RESERVE myfilter 0.01 100
# Returns: -ERR item exists
```

**Error Cases:**
- Filter already exists: `-ERR item exists`
- Invalid error rate: `-ERR error rate must be between 0 and 1`
- Invalid capacity: `-ERR capacity must be positive`

### BF.ADD

Add an item to a bloom filter. Auto-creates filter with defaults if it doesn't exist.

**Syntax:**
```
BF.ADD key item
```

**Returns:** 
- `1` if item was newly added
- `0` if item might have already existed

**Default Parameters (auto-create):**
- Capacity: 100
- Error rate: 0.01 (1%)

**Examples:**
```bash
# Add item to bloom filter (auto-creates if doesn't exist)
BF.ADD users alice
# Returns: 1

# Add same item again
BF.ADD users alice
# Returns: 0 (might already exist)

# Add different item
BF.ADD users bob
# Returns: 1
```

### BF.EXISTS

Check if an item exists in a bloom filter.

**Syntax:**
```
BF.EXISTS key item
```

**Returns:**
- `1` if item might exist (possible false positive)
- `0` if item definitely does NOT exist

**Examples:**
```bash
# Check if item exists
BF.EXISTS users alice
# Returns: 1 (might exist)

BF.EXISTS users charlie
# Returns: 0 (definitely doesn't exist)
```

### BF.MADD

Add multiple items to a bloom filter at once.

**Syntax:**
```
BF.MADD key item [item ...]
```

**Returns:** Array of integers (1 or 0 for each item)

**Examples:**
```bash
BF.MADD users alice bob charlie
# Returns: [1, 1, 1]

BF.MADD users alice david eve
# Returns: [0, 1, 1]  (alice might already exist)
```

### BF.MEXISTS

Check if multiple items exist in a bloom filter.

**Syntax:**
```
BF.MEXISTS key item [item ...]
```

**Returns:** Array of integers (1 or 0 for each item)

**Examples:**
```bash
BF.MEXISTS users alice bob frank
# Returns: [1, 1, 0]
# alice might exist (1)
# bob might exist (1)
# frank definitely doesn't exist (0)
```

### BF.INFO

Get information about a bloom filter.

**Syntax:**
```
BF.INFO key
```

**Returns:** Array of key-value pairs with filter statistics

**Examples:**
```bash
BF.INFO users
# Returns:
# ["Capacity", "100", 
#  "Size", "959", 
#  "Number of filters", "1", 
#  "Number of items inserted", "3", 
#  "Expansion rate", "2"]
```

**Error:**
```bash
BF.INFO nonexistent
# Returns: -ERR not found
```

## Usage Examples

### Example 1: Basic Usage

```bash
# Create a bloom filter for 1000 users with 1% error rate
BF.RESERVE users 0.01 1000

# Add users
BF.ADD users alice
# Returns: 1

BF.ADD users bob
# Returns: 1

# Check if user exists
BF.EXISTS users alice
# Returns: 1 (might exist - TRUE in this case)

BF.EXISTS users charlie
# Returns: 0 (definitely doesn't exist)

# Get info
BF.INFO users
# Returns: ["Capacity", "1000", "Size", "9585", ...]
```

### Example 2: Batch Operations

```bash
# Add multiple users at once
BF.MADD users alice bob charlie david eve

# Check multiple users
BF.MEXISTS users alice charlie frank grace
# Returns: [1, 1, 0, 0]
# alice: might exist (1)
# charlie: might exist (1)
# frank: definitely not (0)
# grace: definitely not (0)
```

### Example 3: Auto-Create with Defaults

```bash
# No need to BF.RESERVE, just use BF.ADD
BF.ADD emails user@example.com
# Auto-creates with capacity=100, error_rate=0.01

BF.ADD emails another@example.com
BF.ADD emails test@example.com

# Check
BF.EXISTS emails user@example.com
# Returns: 1
```

### Example 4: Real-World Use Cases

#### Spam Filter
```bash
# Create bloom filter for known spam URLs
BF.RESERVE spam_urls 0.001 1000000

# Add spam URLs
BF.MADD spam_urls badsite.com malware.org phishing.net

# Check if URL is spam
BF.EXISTS spam_urls badsite.com
# Returns: 1 (might be spam)

BF.EXISTS spam_urls google.com
# Returns: 0 (definitely not spam)
```

#### Cache Check
```bash
# Track which items are in cache without storing all keys
BF.RESERVE cache_keys 0.01 10000

# Mark items as cached
BF.ADD cache_keys user:123
BF.ADD cache_keys post:456

# Quick check if item might be cached
BF.EXISTS cache_keys user:123
# Returns: 1 (check cache)

BF.EXISTS cache_keys user:999
# Returns: 0 (skip cache, fetch from DB)
```

## Performance Characteristics

### Time Complexity
- **BF.ADD**: O(k) where k = number of hash functions
- **BF.EXISTS**: O(k)
- **BF.MADD**: O(n*k) where n = number of items
- **BF.MEXISTS**: O(n*k)

### Space Complexity
- For 1% error rate with 100 items: ~960 bits (120 bytes)
- For 1% error rate with 1,000 items: ~9,585 bits (1,198 bytes)
- For 0.1% error rate with 1,000 items: ~14,378 bits (1,797 bytes)

### Space Savings Example
```
Traditional Set:
- 1,000 URLs (avg 50 bytes each): 50,000 bytes

Bloom Filter (1% error rate):
- 1,000 URLs: ~1,200 bytes

Space savings: 98% less memory!
```

## Error Rate vs Memory

| Error Rate | Bits per Item | Example (1000 items) |
|-----------|---------------|---------------------|
| 0.1% (0.001) | ~14.4 | 14,378 bits (~1.8 KB) |
| 1% (0.01) | ~9.6 | 9,585 bits (~1.2 KB) |
| 5% (0.05) | ~6.2 | 6,236 bits (~780 bytes) |
| 10% (0.1) | ~4.8 | 4,793 bits (~600 bytes) |

Lower error rate = more memory needed

## Understanding False Positives

```bash
BF.RESERVE test 0.01 100  # 1% false positive rate

# Add 100 items
for i in 1..100:
  BF.ADD test "item{i}"

# Check 100 items that were NOT added
# Expected: ~1 false positive (1% of 100)
for i in 101..200:
  BF.EXISTS test "item{i}"
  # Most return 0 (correct)
  # ~1 might return 1 (false positive)
```

## Limitations

❌ **Cannot Remove Items**: Standard bloom filters don't support deletion
❌ **False Positives**: Can incorrectly say an item exists
❌ **Fixed Size**: Cannot dynamically grow (in this implementation)
✅ **No False Negatives**: If it says NOT there, it's definitely not there
✅ **Space Efficient**: Much smaller than storing actual data
✅ **Fast**: Constant-time operations

## Integration with Redis

### TYPE Command

```bash
BF.ADD myfilter item
TYPE myfilter
# Returns: "MBbloom--" (RedisBloom module type identifier)
```

### WATCH Support

```bash
WATCH myfilter
MULTI
BF.ADD myfilter newitem
EXEC
# Works with optimistic locking!
```

## Comparison with Sets

| Feature | Set (SADD) | Bloom Filter (BF.ADD) |
|---------|-----------|---------------------|
| Memory | High (stores data) | Low (stores bits) |
| False positives | None | Possible |
| False negatives | None | None |
| Removal | Yes (SREM) | No |
| Exact membership | Yes | No |
| Use case | Small sets, exact queries | Large sets, approximate queries |

## When to Use Bloom Filters

### ✅ Good Use Cases
- Checking if URL has been visited (billions of URLs)
- Spam filtering (millions of spam patterns)
- Cache existence checks (avoid expensive lookups)
- Duplicate detection in large datasets
- Blacklist/whitelist checks

### ❌ Not Suitable For
- Small datasets (just use a Set)
- When false positives are unacceptable
- When you need to remove items
- When you need exact membership

## Real-World Examples

### Web Crawler
```bash
# Track visited URLs to avoid revisiting
BF.RESERVE visited_urls 0.001 10000000  # 10M URLs, 0.1% error

# Before crawling, check if URL was visited
BF.EXISTS visited_urls "example.com/page1"
# If 0: crawl it and add to filter
# If 1: skip (might have been visited)

BF.ADD visited_urls "example.com/page1"
```

### Rate Limiting
```bash
# Track IPs that exceeded rate limit in last hour
BF.RESERVE rate_limited_ips 0.01 100000

# Check if IP is rate limited
BF.EXISTS rate_limited_ips "192.168.1.1"
# If 1: reject request
# If 0: allow request
```

### Database Query Optimization
```bash
# Bloom filter of all user IDs in database
BF.RESERVE user_ids 0.001 1000000

# Quick check before expensive DB query
BF.EXISTS user_ids "user123"
# If 0: skip DB query, return "not found"
# If 1: query DB (might exist)
```

## Summary

Your Redis server now supports Bloom Filters with all major commands:
- ✅ `BF.RESERVE` - Create with custom parameters
- ✅ `BF.ADD` - Add single item
- ✅ `BF.EXISTS` - Check single item
- ✅ `BF.MADD` - Add multiple items
- ✅ `BF.MEXISTS` - Check multiple items
- ✅ `BF.INFO` - Get filter statistics
- ✅ Optimal bit array sizing based on capacity and error rate
- ✅ FNV-1a hash function with multiple seeds
- ✅ Integration with TYPE and WATCH commands

Bloom filters are perfect for large-scale approximate membership testing with minimal memory usage! 🚀

