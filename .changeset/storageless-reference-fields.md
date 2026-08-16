---
"emdash": minor
---

Reference fields no longer store a value on the collection's table — their selections are content-reference edges, created and removed with the field's relation. Set them through an entry's reference endpoints; sending one under `data` is now a validation error, and reads no longer return it. **Breaking:** values that an older version wrote into a reference field's column are no longer read or written, so re-select them; the column itself is left in place untouched.
