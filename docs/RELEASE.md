# Releasing dsh-upkeep

Semver: `0.x` minor for behaviour, patch for fixes. Never publish a version that
has not passed every step below.

## 1. Prove it locally

```sh
npm install
npm run verify          # types, build, all tests, client script syntax
npm run verify:pack     # the tarball npm would publish, in a throwaway profile
```

`verify:pack` needs a running DSH installation for its CLI step. It prints
`SKIP` (never `PASS`) when it cannot find one.

## 2. Prove it in the real app

1. Restart the Harness so the Host half reloads, then refresh the page.
2. Panel: counts, sentence, both tables, the Actions column, the footer.
3. Both dialogs: Escape and backdrop close, the schedule default is `08:00`.
4. Create a scheduled task, then check Automation tasks: the stored prompt is the
   launcher with an `<!-- upkeep-task:vN -->` marker.
5. Upgrade → Prepare: a session starts on its own in
   `<repo>/.worktrees/upkeep/<run>`, the one-shot task disappears after ~10 s, and
   the main checkout stays clean.
6. Verify → Create PR → (only with `allowMerge`) Merge. A merge removes the worktree
   and its branch.

## 3. Record what changed

- `CHANGELOG.md`: one section per version, behaviour first, breaking notes called out.
- `docs/EVIDENCE.md`: every new assertion about DSH behaviour, with its file.
- `docs/PLAN.md`: scope or decision changes (D1–D15).
- READMEs (English and Chinese) — both must say the same thing.

## 4. Publish

```sh
npm version <patch|minor> --no-git-tag-version   # then commit the three files
git tag v<version>
git push && git push --tags
npm publish --access public                      # scoped package: access must be public
```

`files` decides what ships; `npm run verify:pack` already asserts the contents, so
do not edit `files` without re-running it.

## 5. After publishing

1. `npm view @sleep9ull/dsh-upkeep version dist-tags` — the `latest` tag must be the
   version just published.
2. Install the published package into a scratch profile and confirm the panel
   appears (this is the only step that exercises the registry, not the checkout).
3. GitHub Release from the tag, with the changelog section as the body.
4. If this release changed the upgrade prompt or the schedule launcher, note it: the
   launcher generation is `TASK_PROMPT_VERSION` in `src/host/schedule.ts`, and old
   tasks are brought forward at startup.
