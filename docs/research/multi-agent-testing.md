# Running tests under many concurrent coding agents

This survey covers how existing build and test tools key, deduplicate, cap and trust test runs. It then tests the sketched `devharness test` design against them. The setting is up to ten Claude Code sessions on one machine, working in one JS/TS repo (vitest) and possibly one Python repo (pytest). Today each session runs the full test command itself, so the runs compete for CPU and RAM and repeat the same work.

Each claim carries a numbered citation into the References list at the end. Claims marked **(unverified)** could not be confirmed against a primary source during this survey. The machine this was written on reports `os.availableParallelism()` = 10 and 16 GiB RAM (measured with `node -e`). The arithmetic in section 3 uses those numbers.

## 1. Input-keyed result caching: what goes into the key

**Bazel.** Bazel splits a build into actions. Each action "has inputs, output names, a command line, and environment variables", and the action cache maps "action hashes to action result metadata" [6]. A test is an action like any other. With `--cache_test_results=auto` (the default), Bazel reruns a test "if and only if" one of four things holds: the test or its dependencies changed, the test is tagged `external`, `--runs_per_test` asked for several runs, or "the test previously failed" [2]. A cached pass is therefore reused, and a cached failure is not. Results are saved whatever the flag says. The flag "only affects whether Bazel will use previously saved results, not whether it will save results of the current run" [3]. `--check_tests_up_to_date` reports cached results without running anything. It marks a test whose result is out of date "NO STATUS" and exits non-zero [3]. That is the read-only "was this already tested" query the sketch wants.

Three documented leaks bound how far the Bazel key can be trusted:
- **Environment.** Only variables allowlisted with `--action_env` enter the action key, and differing `$PATH` values stop machines sharing hits [6]. Tests "should not depend on the presence, absence, or value of any environment variable not listed" in the test encyclopedia [1].
- **Tools outside the workspace.** These are not tracked. Two users with different compilers in `/usr/bin` "will wrongly share cache hits" because the outputs differ while the action hash is the same [6].
- **Files edited during the run.** "When an input file is modified during a build, Bazel might upload invalid results to the remote cache". The guard is `--experimental_guard_against_concurrent_changes`, and the advice is to "avoid modifying source files during a build" [6]. This leak bears most directly on agents that share a working directory (section 4).

**Nx.** A task hash can include project source files and files from dependencies, workspace configuration, external dependency versions, "Runtime values, such as the operating system and CPU architecture", and command-line arguments. On a hit, Nx "restores the cached output files and prints the stored terminal output" [7]. Environment variables and commands such as `node --version` enter the hash only when declared as inputs. Nx states that "e2e test runs that hit the backend API cannot be cached as the backend might influence the result" [7].

**Turborepo.** A global hash and a task hash both feed the key, and "If either of the hashes change, the task will miss cache." The global hash covers the resolved `turbo.json` task definition, root lockfile changes and passthrough arguments. The task hash covers package configuration, lockfile changes for the package, its `package.json`, and by default "all source-controlled files in the package directory" [9]. Logs are restored "from the first time that the task ran" [9]. For environment variables, Strict Mode (the default) filters the task's runtime environment down to the declared `env`/`globalEnv` variables. An undeclared dependency then tends to fail the task instead of producing a silent wrong hit. The docs state this is not a guarantee: a task that tolerates a missing variable can still hit wrongly [10]. `passThroughEnv` variables reach the task without entering the hash [10]. Whether Turborepo writes cache entries for failed tasks is **(unverified)**: the caching page reviewed does not say [9].

**Pants.** "Each file gets run as a separate process, which gives you fine-grained caching." After one changed file, "only tests that depended on that changed file will need to rerun" [13]. Tests are hermetic: they are "stripped of the parent pants process's environment variables", which "increases cache hits". Variables are added back per target with `extra_env_vars` [13]. Batched tests are cached together, so a change to any file in the batch invalidates the whole batch [13]. `pants test --force` bypasses the cache [13].

**Gradle.** The key holds the task type and classpath, output property names, declared inputs, the Gradle and plugin classpath, and relevant build script content. "The task path is not an input to the build cache key", so tasks at different paths reuse each other's outputs [14]. `Test` is among the cacheable built-in tasks [14]. "Cacheable tasks should have repeatable task outputs", or the executed result and the cached result can differ [15]. Gradle disables caching automatically for tasks whose output directories overlap [15]. Whether Gradle stores a failed task's outputs is **(unverified)**: neither build-cache page reviewed says so [14][15].

**Across all five**, the key has the same four parts: content hashes of declared files, the command and its arguments, an allowlist of environment variables, and the toolchain or runtime. None of the five puts the checkout's absolute path into the key. Gradle states this outright [14], and Bazel's remote cache shares hits across machines [6]. A key that holds the path splits results between two checkouts of identical code. A key that leaves out environment or toolchain produces false hits.

## 2. File-to-test mapping: static import graph versus coverage

**Vitest.** `vitest related <files>` "Run[s] only tests that cover a list of source files. Works with static imports … but not the dynamic ones (e.g., `import(filepath)`)" [17]. `--changed [since]` runs the tests affected by uncommitted changes, or by changes since a commit or branch [18]. Changes to files every test depends on rerun the whole project: `setupFiles`, `globalSetup`, a custom runner or environment, `snapshotSerializers`, `.env` files from `envDir`, and the config file "with everything it imports". Vitest also follows `@vitest-environment` comments, `__mocks__` files used by factory-less `vi.mock`, and each test's snapshot file. "Files passed to `toMatchFileSnapshot` are not tracked" [18]. `forceRerunTriggers` (default `**/package.json`, `**/vitest.config.*`, `**/vite.config.*`) reruns the whole suite when a matching file is in the diff. Vitest names the case this covers: a test that spawns `node dist/index.js` has no module-graph edge to that file [20]. Vitest's own result cache stores, per test file, "whether the file failed, which tests failed, how long it ran and when it ran last". "A run that did not execute the whole file … can mark the file as failed, but it cannot mark it as passed" [21]. devharness pins `vitest ^3.2.4` (`package.json`). The docs above describe the current release, which mentions Vitest 5 [17], so flag-level details need checking against the installed version.

**Jest.** `--findRelatedTests` finds "the tests that cover a space separated list of source files". `--onlyChanged` "requires a static dependency graph (ie. no dynamic requires)", and `--changedSince` compares against a branch or commit [23].

**pytest-testmon (coverage-based).** testmon collects "dependencies between tests and all executed code (internally using Coverage.py)" and compares them against changes. It needs one full `--testmon` run before it can select anything [24]. It splits source into blocks and stores a checksum per block, so editing a line a test never executed does not select that test [25]. "The limits and reliability of this method are pretty much the same as limits of coverage.py" [25]. "Testmon always re-executes tests which failed last time" [24]. `--testmon-env` keeps separate dependency data for different environments in one data file [24]. Selection is forced off under `-k`, `-m`, `-lf` and explicit node ids, and data collection is forced off under a debugger or coverage [24]. testmon's author also calls out order-dependent tests: an outcome that depends on test order is deterministic, with order as one of its inputs. Running each test in isolation and running in reverse order expose them [26].

**Microsoft Test Impact Analysis.** TIA builds a dynamic dependency map from test execution. It always includes "previously failing tests, and newly added tests". For commits it cannot reason about, such as HTML or CSS changes, it "falls back to running all tests" [28]. Microsoft recommends a full run at a configured interval, and validating selection by running impacted tests and then all tests [28]. TIA is not supported for multi-machine topologies, data-driven tests or adapter-level parallel execution [28].

**Meta and Google at scale.** Meta's predictive test selection paper describes its earlier strategy: choose every test that transitively depends on modified files through build dependencies. Strict build isolation makes this sound, but it selects tests "in the order of 10^4" per change [29]. Finer static analysis loses precision on language features such as reflection and is "hard to apply in multilingual code bases". All dynamic methods "must be treated as approximate", and "maintaining per-test code coverage information accurate enough to drive the test selection process is impractical in large monolithic repositories" [29]. Meta's learned selector "reduces the total infrastructure cost of testing code changes by a factor of two" and still reports "over 95% of individual test failures and over 99.9% of faulty changes" [29]. The paper cites Legunsen et al. (FSE 2016) as finding that class-level static selection matches dynamic selection (Ekstazi) [29]. That finding was read only through Meta's citation **(unverified at source)** [48]. Google's Memon et al. report that "very few of our tests ever fail, but those that do are generally 'closer' to the code they test" [31].

**Accuracy and cost.** Static import graphs cost one parse and no prior run. They over-select, because importing a module does not mean executing the changed lines. They under-select on dynamic imports, subprocesses, file fixtures and config [17][18][20][23]. Coverage-based maps select more tightly at block level. They need a full instrumented run first, they describe the previous version of the code, and they inherit coverage.py's blind spots [24][25][29]. Both tools that ship a map in production add the same two safety rails: always rerun what failed last time [2][24][28], and fall back to everything on input the map cannot reason about [18][20][28].

## 3. Deduplicating identical work and capping concurrency on one machine

**Single-flight.** Go's `singleflight.Group.Do` "executes and returns the results of the given function, making sure that only one execution is in-flight for a given key at a time. If a duplicate comes in, the duplicate caller waits for the original to complete and receives the same results", with a `shared` flag on the return [45]. `Forget(key)` makes later callers run the function again instead of waiting [45]. This is the leader/follower shape in the sketch, scoped to one process. Across processes, the leader record has to live in the filesystem.

**Bazel's lock is serialisation, not deduplication.** "Each server can handle at most one invocation at a time; further concurrent invocations will either block or fail-fast (see `--block_for_lock`)" [5]. The client finds its server by output base, which defaults to a digest of the workspace path and user. Separate workspaces therefore get separate servers, and separate users can build one workspace concurrently [5]. `--block_for_lock=30s` bounds the wait [3]. Inside one invocation, `--jobs` and `--local_test_jobs` (default `auto`, accepting `HOST_CPUS*.5`) cap concurrency. The scheduler also avoids exceeding RAM/CPU on "very crude" estimates [2][3]. Bazel shares results between concurrent clients only through the action cache once an action has finished. No published Bazel mechanism attaches a second client to a running action's log **(unverified: none found in [2][3][5][6])**.

**Gradle daemon.** Gradle "starts a new Daemon if no idle or compatible Daemons exist", and compatibility is an exact match on Java version, JVM attributes and properties, and Gradle version [16]. Mismatched JDK settings spawn several daemons and raise memory use [16]. No locking rules for a local build cache shared between concurrent builds were found on the official pages **(unverified)** [14][15].

**GNU make jobserver.** make caps "the total number of parallel jobs even across recursive invocations". Child tools that run parallel work can join the protocol so that the total active processes stay within make's slot count [43]. Slots pass through `MAKEFLAGS --jobserver-auth=`, as a named pipe (`fifo:PATH`) or a pair of pipe file descriptors. Every child holds one implicit slot [43][44]. This is the established model for a machine-wide budget shared by independent processes, which is what ten agents need.

**flock.** `flock(2)` locks belong to the open file description. A lock "is released either by an explicit LOCK_UN … or when all such file descriptors have been closed", so a crashed holder releases it without cleanup [46]. Over SMB on Linux the lock becomes mandatory, and NFS has its own interaction rules [46]. macOS provides `flock(2)` [47] and ships no `flock(1)` command (`which flock` returns nothing on this machine). Node exposes no `flock` binding in core **(unverified)**. That leaves the pattern devharness already uses: one file per claim, atomic temp+rename, and pid liveness (`src/server-claims.ts`, `src/helpers/process-liveness.ts`).

**Runner pool sizing and oversubscription.**
- Vitest `maxWorkers` defaults to "all available parallelism" with watch disabled and half with watch enabled, from `os.availableParallelism` [19].
- Jest `--maxWorkers` defaults to cores minus one in single-run mode and half the cores in watch mode, "to ensure Jest is unobtrusive and does not grind your machine to a halt" [23].
- pytest-xdist `-n auto` uses physical cores [27].

Each default sizes one run to the whole machine. Ten concurrent `vitest run` processes on this 10-way machine therefore ask for up to 100 workers. Vitest documents that past some count extra workers slow a run: "every worker funnels its transform requests through the single main-thread Vite server". `vitest doctor` probes lower `maxWorkers` values for this reason [17]. Pants shows the fix: it caps total parallel tests across processes at `process_execution_local_parallelism` (default: CPU count). With 8 CPUs and 8 concurrent pytest processes, "it will pass `-n 1` to each process so that the total concurrency is 8" [13]. `poolOptions` does not appear in the current Vitest config index [22], so worker count is set through `maxWorkers`.

## 4. Isolation for parallel agents

**Claude Code.**
- Claude Code's documented answer to parallel sessions is one git worktree per session: `claude --worktree <name>` creates `.claude/worktrees/<name>/` on a branch `worktree-<name>` [33][34].
- Worktrees "isolate file edits" [34]. Each is "a fresh checkout", so dependencies have to be installed in it, and `.worktreeinclude` copies gitignored files such as `.env` [34].
- Subagents get the same isolation with `isolation: worktree` [34]. Agent teams are told to "Break the work so each teammate owns a different set of files" because two teammates editing one file overwrite each other [38].
- Hooks see the worktree through the input's `cwd` field. `${CLAUDE_PROJECT_DIR}` stays at the session's starting root [34].
- On Linux and WSL, `CLAUDE_CODE_TOOL_MEMORY_LIMIT` caps the memory of all of one session's Bash commands taken together. It is per session and not machine-wide [36].

**Codex and Cursor.** Codex runs setup scripts "automatically when Codex creates a new worktree at the start of a new chat". It offers "actions" for tasks such as "running your test suite", and recommends a worktree "To isolate concurrent changes from your local checkout" [41]. Cursor configures per-worktree setup in `.cursor/worktrees.json`. It does "not recommend symlinking dependencies into the worktree" because "This can cause issues in the main worktree", and caps worktrees at "25 … per machine" [42].

**What the working-directory choice does to the result key.**
- *Shared working directory.* The files on disk at hash time hold every agent's uncommitted edits. A result then belongs to the combined tree, which no single agent's change describes. A second agent can also edit files after the fingerprint is taken and before the runner reads them. That is the failure Bazel documents for files modified during a build [6]. The key must be re-hashed when the run ends, and a result whose start and end hashes differ cannot be stored as a hit. A run started from agent A's command can still serve agent B, but only while B's view of the tree equals the hashed tree. Equal file hashes establish that, so the key has to be content, not session.
- *Per-agent worktree.* The tree is stable for the agent that owns it. Two worktrees at the same content produce the same file hashes. A key that leaves out the absolute path then shares results across worktrees, which is how Gradle [14] and Bazel's remote cache [6] share across paths. Each worktree carries its own `node_modules` or virtualenv [34][42], so the lockfile hash and the runtime version have to be in the key. Otherwise two worktrees with different installs share a hit.

**Specific guidance for testing under many agents is thin.** The Claude Code, Codex and Cursor pages reviewed [33]–[42] cover edit isolation and per-worktree setup. None of them addresses CPU contention between agents' test runs, deduplicating identical runs, or sharing results across sessions. Codex's "actions" and Cursor's setup keys configure commands per worktree and do not coordinate them [41][42].

## 5. Flaky tests and result trust

**Rates.** Google reported "a continual rate of about 1.5% of all test runs reporting a 'flaky' result". "Almost 16% of our tests have some level of flakiness", and "about 84% of the transitions we observe from pass to fail involve a flaky test" [30]. Google defines a flaky result as "a test that exhibits both a passing and a failing result with the same code" [30]. Meta states that "all real-world tests are flaky to some extent". Inherent flakiness is "well below 1 percent" for unit tests and reaches "10 percent" for some end-to-end frameworks [32].

**Mechanisms in the caching tools.**
- Bazel's `flaky = True` attribute "executes the test up to three times, marking it as failed only if it fails each time", and its use "is generally discouraged" [4].
- `--flaky_test_attempts` retries up to N times and marks tests that needed more than one attempt "FLAKY" [2].
- `--runs_per_test_detects_flakes` marks a shard FLAKY when one run passes and another fails [2].
- `--cache_test_results=auto` never reuses a failure [2].
- Whether Bazel serves a FLAKY-then-passed result as a cache hit is **(unverified)**.
- Nx Cloud detects flakiness through the cache key: "If Nx ever encounters a task that fails with a particular set of inputs and then succeeds with those same inputs, it marks that task as flaky". It clears the flag after "no flakiness incidents for 2 weeks" and reruns flaky tasks on a different agent [8].
- Pants offers `attempts_default` retries [13].

**Quarantine practice.** Google's "flaky" marking reports failure "only if it fails 3 times in a row". Google states the cost: a broken 15-minute test so marked takes 45 minutes to surface [30]. Its auto-quarantine "removes the test from the critical path and files a bug" and "could easily mask a real race condition" [30]. Meta tracks a probabilistic flakiness score per test from a Bayesian model over its result history. It files a ticket when the score trends up and marks tests that deteriorate "as flaky", which makes them ineligible for change-based testing [32]. Meta's selection paper separates flaked from failed outcomes by retrying before it trains or evaluates. Without that step its recall would be overstated threefold [29].

**What this does to a cache.** A pass under a given input hash is evidence of passing, not proof, at rates between under 1% and 10% per run depending on test kind [32]. A single stored pass served as "your code was tested, it passed" hides the flaky fraction. Nx's rule turns the per-test store into a detector at no extra cost: two outcomes under one hash means flaky [8].

## 6. What this means for `devharness test`

**PreToolUse hook rewriting test commands.**
- *Supported.* A `PreToolUse` hook's `updatedInput` "Replaces the entire input object", so the hook must return `description`, `timeout` and `run_in_background` unchanged alongside the rewritten `command` [35].
- *Adds three constraints.*
  - Permission rules and auto-background eligibility are evaluated "against the input your hook returns, not the input Claude sent" [35]. An allow rule for `npm test` stops matching once the command becomes `devharness test -- npm test`, so the rewrite needs an allow rule for `devharness test` or a `permissionDecision: "allow"` beside it.
  - In auto mode, a rewrite returned with no decision can be denied because the server reviewed the original. A `command` hook from settings or a plugin's hooks file is exempt for Bash [35], so the hook ships as a command hook.
  - Foreground Bash defaults to a 120 s timeout. At timeout the command moves to the background instead of stopping [36]. A follower that tails a long leader run gets backgrounded mid-tail, so its output has to keep landing in the file Claude Code reads.
- The hook reads the worktree from the `cwd` input field, not `${CLAUDE_PROJECT_DIR}` [34].

**Run key = repo path + command + code fingerprint.**
- *Contradicted on the path, incomplete on the rest.* No tool surveyed keys on the checkout path [6][14]. Keying on it splits results between worktrees at identical content, and per-worktree sessions are the documented setup [34].
- The evidence supports this key: content hash of the inputs, the normalised command, an env allowlist (Turborepo's `env`/`passThroughEnv` split [10], Bazel's `--action_env` [6]), lockfile hash, and runtime version (Nx's runtime inputs [7]).
- *Adds an end-of-run re-hash.* A result whose inputs changed during the run is reported to its waiters and never stored as a hit [6].
- Prior art to borrow: Turborepo's Strict Mode env filtering [10] and Bazel's concurrent-change guard [6].

**One leader, followers tail the log and share the exit code.**
- *Supported* by `singleflight.Do` semantics [45]. The follower contract follows from it: same key means same result, with a `shared` marker. Bazel shows the alternative of blocking on a lock, which serialises without sharing [5].
- *Adds three rules.*
  - A follower attaches only when its key equals the leader's.
  - A leader whose pid dies leaves followers to elect a new leader, the `Forget` case [45].
  - The leader record takes a pid plus start time, as `server-claims.ts` already does, because `isProcessAlive` alone is fooled by pid reuse.
- `flock(2)` releases on close with no cleanup [46]. Node lacks a core binding (unverified) and macOS lacks `flock(1)`, so the existing claim-file pattern is the practical base.

**Per-repo and global concurrency caps.**
- *Supported, and not sufficient alone.* A cap on the number of runs leaves each admitted run sized to the whole machine [19][23][27].
- The evidence adds a worker budget. devharness injects `--maxWorkers=<share>` for vitest, `--maxWorkers` for Jest and `-n <share>` for xdist, so the sum across admitted runs stays at or under `availableParallelism`. That is Pants' `-n 1` rule [13] and make's slot pool [43].
- Vitest documents that past some worker count a run slows [17], so the per-run share has a ceiling below the core count. `vitest doctor` measures it [17].

**Per-test results keyed on test file + import closure.**
- *Supported* by Pants' per-file granularity [13] and Nx's per-task keys [7].
- *Adds the whole-project inputs Vitest tracks:* setup files, global setup, environment, serializers, `.env`, config and its imports, `__mocks__`, snapshots [18]. A closure built from imports alone misses these and serves stale passes.
- *Adds the reuse rule:* reuse passes and never failures, as Bazel's `auto` does [2] and testmon does [24]. A partial run can record a failure and cannot record a pass, as Vitest's cache does [21].
- *Adds the flaky rule:* each hash keeps an outcome history, not one result. A hash with both outcomes is reported as flaky, not as passed [8][30][32].
- "Was my code already tested" then answers with a count and outcomes per hash. Example: "passed 3/3 under this hash", or "flaky: 2 pass, 1 fail".

**`devharness test related <file>` with current/stale/never-run and `--run`.**
- *Supported for JS* by `vitest related` and `--changed` [17][18]. Jest's equivalents work the same way [23].
- *Adds the blind spots:* dynamic imports, subprocess-driven tests and `toMatchFileSnapshot` files are not tracked [17][18][20]. A `forceRerunTriggers`-style list [20] and TIA's fallback to all tests for file types the map cannot reason about [28] keep the stale marking conservative.
- *For Python* the static mapping has no first-party pytest equivalent among the sources reviewed. testmon is the coverage-based option [24][25]. It needs a full run first, and `--testmon-env` separates environments [24].
- *Adds a periodic full run.* TIA recommends one [28], and Meta and Google treat every selection method as approximate [29][31].
- "stale" has two causes that the output keeps apart: an input changed, or the stored history is flaky.

**Claims not verified from a primary source.**
- Turborepo's and Gradle's treatment of failed tasks.
- Whether Bazel caches a FLAKY-then-passed result.
- Whether a Bazel client can attach to a running action's log.
- Gradle local cache locking.
- Node's lack of a core `flock` binding.
- Legunsen et al.'s finding, read only through Meta's citation.

## References

1. Bazel, *Test encyclopedia*. https://bazel.build/reference/test-encyclopedia. Backed: env-var rule for tests, `external` tag disables caching, `TEST_TMPDIR`.
2. Bazel, *Command-line reference*. https://bazel.build/reference/command-line-reference. Backed: `--cache_test_results` rules, `--flaky_test_attempts`, `--runs_per_test_detects_flakes`, `--local_test_jobs`, `--test_env`, `--block_for_lock`.
3. Bazel, *Commands and options (user manual)*. https://bazel.build/docs/user-manual. Backed: results always saved, `--check_tests_up_to_date`, `--jobs` and the resource scheduler, `--block_for_lock` presubmit use.
4. Bazel, *Common definitions (test attributes)*. https://bazel.build/reference/be/common-definitions. Backed: `flaky` attribute runs up to three times and is discouraged.
5. Bazel, *Client/server implementation*. https://bazel.build/run/client-server. Backed: one invocation per server, server located by output base.
6. Bazel, *Remote caching*. https://bazel.build/remote/caching. Backed: action key contents, `--action_env`, untracked tools outside the workspace, files modified during a build.
7. Nx, *How caching works*. https://nx.dev/docs/concepts/how-caching-works. Backed: hash inputs incl. runtime values, restored terminal output, side-effecting tests not cacheable.
8. Nx, *Flaky tasks*. https://nx.dev/docs/kb/flaky-tasks (redirect target of https://nx.dev/ci/features/flaky-tasks). Backed: flaky = same hash fails and succeeds; flag clears after 2 weeks; rerun on another agent.
9. Turborepo, *Caching*. https://turborepo.dev/docs/crafting-your-repository/caching (redirect from turborepo.com). Backed: global and task hash contents, log replay, outputs restored.
10. Turborepo, *Using environment variables*. https://turborepo.dev/docs/crafting-your-repository/using-environment-variables. Backed: Strict vs Loose mode, `env`, `passThroughEnv`, framework inference.
11. Turborepo, *turbo run reference*. https://turborepo.dev/docs/reference/run. Checked: `--concurrency` default 10, `--cache-dir`. Not cited inline.
12. Pants, *Advanced target selection*. https://www.pantsbuild.org/stable/docs/using-pants/advanced-target-selection. Checked: `--changed-since`, `--changed-dependents=transitive`. Not cited inline.
13. Pants, *test goal (Python)*. https://www.pantsbuild.org/stable/docs/python/goals/test. Backed: per-file processes and caching, hermetic env, batching invalidation, `--force`, `attempts_default`, global parallelism cap with `-n 1`.
14. Gradle, *Build cache*. https://docs.gradle.org/current/userguide/build_cache.html. Backed: key contents, task path excluded from key, `Test` cacheable.
15. Gradle, *Build cache concepts*. https://docs.gradle.org/current/userguide/build_cache_concepts.html. Backed: repeatable outputs, overlapping outputs disable caching.
16. Gradle, *Gradle daemon*. https://docs.gradle.org/current/userguide/gradle_daemon.html. Backed: daemon compatibility by exact match, multiple daemons raise memory.
17. Vitest, *Command line interface*. https://vitest.dev/guide/cli. Backed: `vitest related` static imports only, `--changed`, `vitest doctor` and worker funnelling through one Vite server, Vitest 5 static `list`.
18. Vitest, *changed* config. https://vitest.dev/config/changed. Backed: project-wide inputs tracked by `--changed`, untracked `toMatchFileSnapshot`.
19. Vitest, *maxWorkers* config. https://vitest.dev/config/maxworkers. Backed: default worker counts from `os.availableParallelism`.
20. Vitest, *forceRerunTriggers* config. https://vitest.dev/config/forcereruntriggers. Backed: defaults, subprocess case with no module-graph edge.
21. Vitest, *cache* config. https://vitest.dev/config/cache. Backed: per-file result cache, partial runs cannot mark passed.
22. Vitest, *Config index*. https://vitest.dev/config/. Backed: `poolOptions` absent from current option list.
23. Jest, *CLI options*. https://raw.githubusercontent.com/jestjs/jest/main/docs/CLI.md (source of https://jestjs.io/docs/cli, also read). Backed: `--findRelatedTests`, `--onlyChanged` static graph, `--changedSince`, `--maxWorkers` defaults.
24. testmon, *testmon.org*. https://testmon.org/. Backed: Coverage.py-based dependencies, full first run, failed tests always re-run, `--testmon-env`, forced selection/collection modes.
25. testmon, *Determining affected tests*. https://testmon.org/blog/determining-affected-tests/. Backed: block checksums, coverage.py limits.
26. testmon, *Hidden test dependencies*. https://testmon.org/blog/hidden-test-dependencies/. Backed: order-dependent tests are deterministic with order as an input.
27. pytest-xdist, *Running tests across multiple CPUs*. https://pytest-xdist.readthedocs.io/en/stable/distribution.html. Backed: `-n auto` uses physical cores.
28. Microsoft, *Use Test Impact Analysis*. https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-impact-analysis. Backed: dynamic map, always runs failing and new tests, fallback to all tests, periodic full runs, unsupported scenarios.
29. Machalica, Samylkin, Porth, Chandra, *Predictive Test Selection* (Meta). https://arxiv.org/abs/1810.05286 (PDF https://arxiv.org/pdf/1810.05286). Backed: build-dependency selection ~10^4 tests, static/dynamic limits, 2x cost cut with 95%/99.9% recall, deflaking before training.
30. Micco, *Flaky Tests at Google and How We Mitigate Them*. https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html. Backed: 1.5%, 16%, 84% figures; flaky definition; fail-3-times marking and its 45-minute cost; auto-quarantine.
31. Memon et al., *Taming Google-Scale Continuous Testing* (ICSE-SEIP 2017). https://research.google/pubs/taming-google-scale-continuous-testing/. Backed: failing tests are "closer" to changed code. Also seen: https://research.google/pubs/pub45861/, https://www.cs.umd.edu/~atif/pubs/Memon_2017_TGC_3103112.3103143-abstract.html (abstract and citation).
32. Meta Engineering, *Probabilistic flakiness*. https://engineering.fb.com/2020/12/10/developer-tools/probabilistic-flakiness/. Backed: all tests flaky to some extent, unit vs e2e rates, PFS use and flaky marking.
33. Claude Code, *Common workflows*. https://code.claude.com/docs/en/common-workflows. Backed: parallel sessions with `--worktree`.
34. Claude Code, *Worktrees*. https://code.claude.com/docs/en/worktrees.md. Backed: worktree location, fresh checkout needs setup, `.worktreeinclude`, subagent isolation, hook `cwd` vs `${CLAUDE_PROJECT_DIR}`, what worktrees share.
35. Claude Code, *Hooks reference*. https://code.claude.com/docs/en/hooks.md. Backed: `updatedInput` replaces whole input, permission rules evaluated on rewritten input, auto-mode exemption for command hooks, 600 s hook timeout.
36. Claude Code, *Tools reference*. https://code.claude.com/docs/en/tools-reference.md. Backed: 120 s default Bash timeout, auto-backgrounding at timeout, Linux-only per-session memory cap.
37. Claude Code, *Run agents in parallel*. https://code.claude.com/docs/en/agents.md. Checked: comparison of parallel approaches. No test-contention guidance.
38. Claude Code, *Agent teams*. https://code.claude.com/docs/en/agent-teams.md. Backed: "Avoid file conflicts".
39. Claude Code, *Best practices*. https://code.claude.com/docs/en/best-practices.md. Checked: no guidance on concurrent test runs.
40. Claude Code, *Agent view* and *Subagents*. https://code.claude.com/docs/en/agent-view.md, https://code.claude.com/docs/en/sub-agents.md. Checked: subagent cwd and worktree inheritance. No test-contention guidance.
41. OpenAI Codex, *Local environments*. https://learn.chatgpt.com/docs/environments/local-environment.md (redirect from https://developers.openai.com/codex/app/local-environments.md). Backed: setup scripts per worktree, actions for test suites, worktrees for isolation.
42. Cursor, *Worktrees*. https://cursor.com/docs/configuration/worktrees. Backed: `.cursor/worktrees.json` keys, no symlinked dependencies, 25-worktree cap.
43. GNU make manual, *Sharing Job Slots with GNU make*. https://www.gnu.org/software/make/manual/html_node/Job-Slots.html. Backed: jobserver caps total jobs across processes, `--jobserver-auth`, implicit slot.
44. GNU make manual, *POSIX Jobserver Interaction*. https://www.gnu.org/software/make/manual/html_node/POSIX-Jobserver.html. Backed: named-pipe and fd-pair forms.
45. Go, *golang.org/x/sync/singleflight*. https://pkg.go.dev/golang.org/x/sync/singleflight. Backed: `Do` duplicate suppression, `shared`, `Forget`.
46. Linux man-pages, *flock(2)*. https://man7.org/linux/man-pages/man2/flock.2.html. Backed: release on close of all descriptors, SMB/NFS behaviour.
47. macOS `flock(2)` man page (local, `man 2 flock`). Backed: advisory lock semantics on macOS.
48. Legunsen et al., *An extensive study of static regression test selection in modern software evolution* (FSE 2016). Not read; cited through [29].

Seen only as search results and not used, because they are not primary or were not read: Gradle forum threads on concurrent cache access (https://discuss.gradle.org/t/parallel-gradle-builds-running-on-jenkins-causing-issue-with-gradle-global-cache/34735, https://discuss.gradle.org/t/concurrent-access-to-remote-build-cache/45569, https://discuss.gradle.org/t/what-is-the-cause-of-intermittent-failed-to-store-cache-entry-for-task-failures/35586), https://issues.gradle.org/browse/GRADLE-2795, https://docs.gradle.org/current/userguide/build_cache_debugging.html, third-party Codex guides (https://www.implicator.ai/intermediate-tutorial-how-to-build-reliable-workflows-with-openai-codex/, https://developertoolkit.ai/en/codex/lessons/new-project/), https://dev.to/dublecc/parallel-ai-agent-workflows-with-git-worktrees-the-concrete-pattern-59lp, https://forum.cursor.com/t/working-with-worktrees-in-cursor/153472/3, and Turborepo canary docs mirrors (e.g. https://v2-8-11-canary-5.turborepo.dev/docs/reference/run.md).
