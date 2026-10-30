# Herdr mods

Mods for the [Herdr](https://herdr.dev) app, one folder each. Each folder has its `mods/<name>/`, maybe a `keys.json` with the keys it expects, a `RECIPE.md` to build it from scratch, and a `preview.png`.

## Git Flow

<img src="git-flow/preview.png" alt="Git Flow panel: branch list and a git-flow graph with colored lanes" width="420">

| Mod | |
| --- | --- |
| [Git Flow](git-flow/RECIPE.md) | The focused terminal's repo as a git-flow graph, drawn from the branches already there (agents' and worktrees' too): smooth colored lanes, a color per branch, and optional actions to start and finish features, releases and hotfixes. Runs `git` only; never pushes. `cmd-shift-g` opens it. |

To add one, ask your agent in Herdr to read `~/.config/herdr-app/AGENTS.md` ("Layouts and mods other people made"), then point it at the folder.

Layouts live in [herdr-layouts](https://github.com/jkuepker/herdr-layouts).

## Licence

MIT (see `LICENSE`).
