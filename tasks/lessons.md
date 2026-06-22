## git: never `git checkout -- .` to drop churn while you have uncommitted real edits

2026-06-22: Lost the lyrics/library panel mounting edits by doing `git stash --keep-index` + `git add` + `git checkout -- .`. The checkout reverted my own un-staged real edits. FIX: to commit a subset amid formatting churn, `git add <specific real files>` then `git commit` only those (git won't touch unstaged churn, and you don't need to discard it to commit). If you must clean churn, do it with `git restore <specific churn files>`, never a blanket `checkout -- .`.
