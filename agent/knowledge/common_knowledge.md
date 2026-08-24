# Franchise tags and always-on facts

These facts are in context before any tool is chosen. They name no undeclared
tables on purpose: a Treasure-Data-era estate described here would put inference
into the artifact wearing the same authority as domain expertise. Use
`resolve_table` and `list_data_assets` for names.

## Franchise tags

- A franchise tag value has to be spelled the way the catalog spells it.
  `cross title` has a space. `cross_title` returns nothing, and nothing looks
  like an answer.
- Case is not the risk: tag search lowercases both sides of both the key and
  the value. `Franchise` and `franchise` match the same tables.
- A tag miss is **untagged**, not "no such data". Some declared tables carry no
  franchise tag at all. Fall back to `list_data_assets`.
- Mapping a spoken franchise to its catalog value is a lookup, not a Genie
  call. Example: "golf" maps to `fairway`.

## Deleted rather than remapped

This knowledge names no tables that this environment does not have. Guessing
that a missing name "is really" another table would be an inference dressed as
expertise. Resolve and list instead.
