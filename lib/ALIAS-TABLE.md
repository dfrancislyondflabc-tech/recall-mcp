# Optional: lib/alias-table.json

`lib/aliases.js` can expand a query term to a family stem — useful when your corpus talks
about product or part numbers that share a prefix (`XY-673A` and `XY-873A` are both
`XY-x73A`). It is **off unless `MEMORY_SKU_ALIAS=1`**, and it looks for `lib/alias-table.json`.

No table ships, because a table is domain data and yours will not be ours. If the file is
absent the loader falls back to an empty table and retrieval is unchanged — verified: the
same query returns the same document at the same score with and without it.

To supply your own:

```json
{ "modelToFamilies": { "xy-673a": ["xy-x73a"] }, "families": { "xy-x73a": ["xy-673a", "xy-873a"] } }
```

Keys are lowercased. A model must never alias to another model — only to a stem — or a
query for one product will retrieve a different one.
