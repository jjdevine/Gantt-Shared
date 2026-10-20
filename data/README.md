# Shared plan data

`people/<person>.json` holds one person's tasks in the shape
`{ "tasks": [ ... ] }`, the same shape the app's Person export produces.

The app reads and writes these files through the GitHub Contents API.
Every save in the app is a commit here. You can also edit a file by hand or
in the GitHub web editor; the app picks it up on its next refresh.

The file name is the person's name lower-cased with non-alphanumerics
replaced by `-`. The `person` field inside each task is the display name.
