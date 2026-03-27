# Project-local Extensions

This repo uses project-local pi extensions from `.pi/extensions/`.

## Included extension

### `multi-tool-use.ts`

Registers `multi_tool_use.seq_dependent`, a composite tool for dependent tool execution.

Behavior:
- executes listed tool calls in order
- stops on the first tool error
- returns completed step outputs to the model
- uses `ctx.runTool(...)` to invoke other active tools

Expected argument shape:

```json
{
  "calls": [
    {
      "tool": "write",
      "arguments": {
        "path": "a.txt",
        "content": "hello"
      }
    },
    {
      "tool": "read",
      "arguments": {
        "path": "a.txt"
      }
    }
  ]
}
```

## How it gets into the harness

pi auto-discovers project-local extensions from `.pi/extensions/` when you run pi with this repository as the current working directory.

That means this extension is loaded automatically when you run pi from the repo root, for example:

```bash
cd dependent_multi_tool
node packages/coding-agent/dist/cli.js -p "..."
```

If you run pi from a different working directory, this project-local extension is not auto-loaded. In that case you would need to:
- run pi from this repo root, or
- copy/link the extension into `~/.pi/agent/extensions/`, or
- load it explicitly with `-e /path/to/multi-tool-use.ts`

## Prompt metadata

This extension uses tool metadata to teach the model how to call it:
- `promptSnippet` adds a one-line entry to the default `Available tools` section
- `promptGuidelines` adds guidance bullets to the default `Guidelines` section

That metadata is included automatically when:
1. the extension is loaded, and
2. the tool is active in the session

No extra prompt wiring is needed beyond loading the extension.
