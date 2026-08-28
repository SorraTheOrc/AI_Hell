# AI Hell - Building A Game with AI Assistance

AI Hell is a classic "Bullet Hell" game written to demonstrate the use of the Context Hub AI framework designed and optimized for using local LLM to assist with coding games (though there's no reason why it can't be used for other types of projects too).

The goal here is not a fully releasable game, but rather a tutorial on how to use the AI Framworks. It's written by humans for a technical target audience, i.e. very little explanation, just instructions. There are extensive AI maintained docs in the code projects referenced here. Point your AI at this as a starting point and ask it questions if you are confused. 

  NOTE FOR AI AGENTS: This document is not for you. This is for human consumption you can stop reading now.

This document starts from zero, if you want to start from somewhere else you are on your own.

This document is written for Linux, everything should work on other platforms, but you might need to figure a few things out for yourself.

Need help? Join us on [Discord](https://discord.gg/CXn2j2nZJf).

## Initial Setup

### Install the Tooling

* [LLM Manager](https://github.com/SorraTheOrc/llm-manager) - Proxy for Local and Remote LLM routing
* [Context Hub](https://github.com/TheWizardsCode/ContextHub) - Orchestrator and Agent Memory system
* [Sorra Agents](https://github.com/SorraTheOrc/SorraAgents) - agent definitions and skills optimized for working with Context Hub

This document works from the `dev` branch of the dependant projects. This is because they are fast moving. They are in constant use and should always be working, but if you want to be less daring work from the `main` branch. We do not yet package releases from those projects.

```bash
git clone git@github.com:SorraTheOrc/llm-manager.git
git clone git@github.com:TheWizardsCode/ContextHub.git
git clone git@github.com:SorraTheOrc/SorraAgents.git
```

Third party projects we depend on:

* [Herdr](https://herdr.dev) - like TMux but agent aware
* [Pi](https://pi.dev) - Lightweight, highly customizable Agent frameowrk

```bash
curl -fsSL https://pi.dev/install.sh | sh
curl -fsSL https://herdr.dev/install.sh | sh
herdr agent enable pi
```

You will also need to setup Pi to use your chosen models, see the [Pi Documentation](https://pi.dev/docs/latest/providers)

### Create the Project

```bash
mkdir AI_Hell
cd AI_Hell
git init
```

### Initialize the Work Log

Context Hub provide a CLI tool called `worklog` (aka `wl`). This provides an interface to the Context system used by AIs (and Humans) to coordinate work. This is central to the orchestration layer in Context Hub.

```bash
cd ContextHub
npm run build
npm link
wl init
```

`wl` uses git to sync its database across instances of the project. For this reason it is necessary to have a remote setup for the git repo. This can be public or private, just as long as there is a remote configured. Below we will create a public repo using the `gh` CLI.

```bash
git add .
git commit -m "Initial worklog configuration"
gh repo create SorraTheOrc/AI_Hell --public --push --source .
```

This asks a few questions. We will reply with:

* Project Name: AI Hell
* Issue ID Prefix: AI
* Auto-Sync data to git after changes: N (you can say yes, but it tends to get slow in large projects - the system is robust without this)
* Agent config: B (basic workflow)

You could start work here. You have a complete memory system with PI and Herdr integrations, but you are not yet using the SorraAgents which add more robust workflow skills. It is highly recommended that you use these agents as there are a number of features in Context Hub that depend on those skills.

#### Initialize Sorra Agents

Sorra Agents are a set of skills and agent definitions that provide a workflow that is optimized for the Context Hub memory and orchestration system. These are not required, but highly recommended. Feel free to create your own, but be aware that some of the Herdr features are (currently?) tied to specific agent skills provided by this package. If you provide equivalent skills of your own then they will start working automatically.

  IMPORTANT: This next step will create a symlink from your global agent config for Pi to the SorraAgents directory. This is a convenience for when working with the development code. However, if you already have a global configuration for your Pi agents this will overwrite that configuration. The good news is that it will backup the previous configuration first, just in case. You can find the backups in (`~/.pi/agent/*.bak.*`). That is skills are replaced, not merged, in order to avoid conflicts. You can restore backed up skills manually. 

```bash
cd ../SorraAgents
./scritps/install_pi.sh
```

This may ask if you want to overwrite `~/.pi/agent/settings.json`, if this is a brand new install of Pi, say yes. If not you may want to review the settings and merge with yours. It may also ask if you want to overwrite `~/.pi/agent/models.json`, you probably want to say no to this one as it contains the configuration for the models I use, but it serves as a good example.

#### Initialize the Proxy

  NOTE: This is the part of the code that is most likely to break for you, but the good news is that it is optional. It is built for specific hardware (GMKTek Evo X2) and as such may need adjusting for your hardware. That said, we are using mature and popular tooling at all the critical points, e.g. llama.cpp, and all our builds are fully scripted. So you should, in theory, be able to point your AI at our scripts and say "adapt this for my hardware". If you do improve the code and add support for other hardware please contribute.

The proxy is a smart routing system that will help you optimize local vs remote LLMs. It's not absolutely necessary, in fact if you intend to work with a single remote model then you may as well skip this step. If you are working with multiple remote models it can provide some useful features, but we recommend skipping it at first. However, if you are using a local LLM alongside remote LLMs it's highly recommended for many reasons (model fallback when busy, error recovery, automatic switching between fast and cheap modes and much more).

##### Compile llama-server (ROCm/HIP build)

Use the rebuild script — it clones llama.cpp master, builds with HIP for the gfx1151 iGPU, stops any running
server, deploys the binary + shared libs to ~/llama.cpp/build/bin/llama-server, and patches the
RUNPATH:

```bash
  scripts/rebuild-llama.sh                  # clone → cmake → build → deploy → verify
```

  - Build flags: -DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1151 -DGGML_HIP_ROCWMMA_FATTN=ON -DLLAMA_OPENSSL=ON
  - Requires git, cmake, patchelf on the host.
  - The deployed path must match llama_server_bin: in proxy/config.yaml (it does by default).
  - A new build may need the MTP spec flags — see scripts/rebuild-and-restart-mtp.sh for that flow.

##### Configure models

The repo contains models.ini and proxy/config.yaml that provide access to the models I use. These will need to be changed

**models.ini** — how llama-server (router mode) loads models. This is standard Llama Server config
  - [global] → ngl = 99 (GPU layers), slot-save-path.
  - One [ModelName] section per model: hf-repo = <org>/<model>:<quant> (the :quant suffix sets quantization),
    ctx-size, plus flags like flash-attn, swa-full, cache-type-k/v, reasoning-format.
  - Existing presets: [Qwen3], [Qwen3-MTP], [Qwen3-Coder-Next], [gpt120], [mxbai-embed].

**proxy/config.yaml** (or config-fast.yaml/config-cheap.yaml — if using multiple modea (see below)). This is how the proxy routes
 requests:
 - models: → each model has an ordered providers: chain: type: local with llama_model: <preset-name> first
   (local Qwen3), then type: remote fallbacks (endpoint, api_key_env, model), plus aliases:.
 - server: → llama_router_mode: true, llama_server_bin:, llama_server_port: 8080, llama_start_script:
   start-llama.sh, TTS on 8081.

  Note that the names of models used in the Herdr Context Hub extension needs to match the names provided in the proxy config. 
  It is therefore easiest to stick with the fallback model names in the config.yaml (e.g. plan, code, audit) provided in the 
  git repo. You can, of course, change the local and remote models you have in thhose fallback chains. You also change the 
  names used in the Context Hub extension by editing `packages/herdr/src/shortcuts.json`.

Changes take effect on restart; new local models need a matching case block in start-llama.sh (lowercase
name) and sometimes a models.ini section — see proxy/MODEL_ADD.md for the full recipe. Models auto-download
from Hugging Face on first load (-hf flag).

##### Run the proxy

```bash
  ./install_proxy.sh                       # one-time: venv + deps + vendored tokenizer
  nohup bash scripts/start-proxy.sh --restart &>/tmp/proxy-startup.log &
```

  --restart kills stale proxy / llama-server / TTS processes first. The script:
  - resolves API keys from env or ~/.pi/agent/auth.json
  - launches the proxy (uvicorn) on port 8000
  - spawns llama-server (router, port 8080) via start-llama.sh and the TTS server (port 8081)

 Verify:

 ```bash
   sleep 30
   curl -s http://localhost:8000/health | python3 -m json.tool
   curl -sS http://localhost:8080/models | jq .          # router model list
   curl -sS -X POST http://localhost:8080/models/load \
     -H "Content-Type: application/json" -d '{"model":"Qwen3"}' -v
 ```

 Health should show status: healthy, llama_server_running: true, tts_server_running: true. If degraded, tail
 -30 /tmp/proxy-startup.log. REST API is OpenAI-compatible at http://localhost:8000/v1/... (web dashboard at
 /).

 Quick checks / useful commands

 ```bash
   ./start-llama.sh router          # run llama-server router manually (port 8080)
   ./start-llama.sh qwen3           # run a single model directly (debug)
   LLAMA_NGL=0 ./start-llama.sh router   # CPU-only fallback (ngl=0)
 ```

## Basic Workflow

It's time to get started. We will demonstrate the entire workflow piece by piece as we build out the AI Hell game.

```bash
herdr
```

Herdr uses a `prefix + KEYS` command system. The default `prefix` is CTRL-B, so when you see `prefix + KEYS` it means press `ctrl-b + KEYS`, e.g. `prefix + l` is `ctrl-b` followd by `l`.

```
prefix + l
```

You just opened the worklog plugin in herdr. This is where you and the agent will coordinate work items within the overall workflow. Right now it is empty. Let's create our first work item. 

  IMPORTANT: you need to have configured Pi to work with a model for this to work, we will be firing off LLM requests. See the first FIXME in the Initialize the Proxy section above for an important caveat.

We will start by creating the `docs/Game Design Document.md` that will have our initial design for the game. Note, however, we will not start by immediately writing the document, instead we will create a work item to track its creation. This is important as the worklog becomes the systems memory. If we simply create the document agents will know the file exists and will read it. But they will not know the decision making process that led to the file looking as it does. Knowing this history is important as it avoids repeating errors or asking the same question multiple times.

A work item goes through four or five stages, depending on how it is initially created. These are:

```
Idea -> Intake Complete -> Plan Complete -> In Review <-> Ready for Release
```

- Idea: A short description of a feature, bug, chore or other work item. This is generally just a note. The goal is for it to be quick to create. The real work happens in later stages and as such it is optional in that you can go straight to Intake if you prefer.
- Intake Complete: a work item that has been processed through the `intake` agent skill, in which the agent reviews existing code, the GDD and related work items, asks questions to clarify intent and eventually writes up a full description of the idea in the context of the game being developed. A work item that is Intake Complete should capture the full intention of the idea from the perspective of a user experience.
- Plan Complete: a work item that has been processed through the `plan` agent skill, which will turn the intake description into an implementation plan. This is done by examining the existing code and related work items and, potentially, seeking clarifications from the producer. The output is a plan that can be described in a single work item or, for larger pieces of work, is broken down into child work items. Each child will automatically be intake complete, but in practice will usually have sufficient information to be considered plan complete at implementation time.
- In Review: A work item that has been processed through the `implement` agent skill. This is where the plan gets turned into code. It is not marked as implemented until all code passes all tests. Usually implementation follows a Test Driven Development model. Before being placed in the In Review state the system also audits the implementation against the previously defined acceptance criteria (first outlined in the Intake stage and refined in the plan stage). Once the work is maked In Review it is ready for final producer review through user testing.
- Ready for Release: A work item that has been processed by the `audit` agent skill AND producer sign-off. The audit skill is the same skill that gates entry into In Review, but it is run a second time with a different agent and different context. Often this stage will catch items that the implementing agent missed. In addition items must be marked as reviewed by the producer in order to enter the Ready for Release stage.

There's the potential for human review between (and even during) each stage. The goal is for the agent to automatically handle the drudgery, low risk and small items that come up, while ensuring the produceris present to handle the creative aspects of development.

### Create an Idea

The Idea stage can easily be skipped if you have time to go through the intake process. However, sometimes you will want to quickly record an idea without slowing yourself down, for example during testing. We aren't going to do this right now, so don't actually run the command below, but if we were to want to do so you would run the following command:

```
wl create -t "Game Design Document for AI_Hell" -d "A fully detailed Game Design Document for the AI_Hell game — a 2D bullet hell loosely based on Galaxians." 
```

There are many more command line parameters that can be provided, us `wl create --help` to list them.

### Work Item Intake

Since we have time right now we will skip the idea step and go straight to the work item intake. To do this we will ensure the Herdr Workload plugin has focus and press `c` for create new. 

This will open a simple form in which you can enter the description of the work item you want to create. You don't need to create a title as this is going to be fed to an LLM so that the intake skill will be run against it. In this form you can also set a priority (critical, high, medium, low), this can be done in the cli with the `--priority` parameter.

Type the same description as we used in the previous section into the form and hit enter.

  If you had entered the idea using the cli, that idea would be listed in the plugin and you could hit `n` for intake (we will use `i` for implement later). 

This will open a new pane in herder and start the intake skill. The skill will ask a series of interview questions to help it create the GDD. Note that these questions are not a part of the skill, so each time you run it the questions asked may be different. Answer the questions with as much or as little detail as you like. 

There is something important to note about this process. The system doesn't just use the information in the work item to understand the ask. It will also search the worklog, documentation and code for useful information. This will be supplied to the LLM as context. In this case the LLM has read this very README.md (which I am writing as I record a video of the process). The system read it and noted that:

```markdown
Potentially related docs/paths: (none exist yet — this is the first artifact)
 - README.md — Informs the GDD: the game is "a classic Bullet Hell game written to demonstrate
   the use of the Context Hub AI framework," built "by humans for a technical target
   audience," and the GDD is located at docs/Game Design Document.md. It also states
   the workflow stage chain (Idea → Intake → Plan → In Review → Release).
```

Note that my work item description did not include the location or filename of the document. It has grabbed this information from the README.md file. It also noticed that the purpose of this game is to demonstrate the use of the Context Hub AI framework and it recognizes that the audience is technical. This information will help guide the GDD interview questions. 

There are plenty of opportunities to adjust this later, so don't worry about the AI taking creative control of the game. It's a good idea to leave some space in the design, sometimes the AI has good "ideas", but you should make sure you nail the core gameplay loop in sufficient detail to ensure the game built is the one you envision. 

  HINT: you can 'zoom' into any pane by giving it focus and hitting `prefix + z`, to "unzoom" use the same shortcut.

### Reviewing the Intake Brief

The output of the intake process is a brief that is stored in the work item description. The LLM will output a summary to in the Herdr pane we are working in, sometimes this will be enough information to fully review the work. However, for something as large and critical as a Game Design Document we are going to want to review the output in detail. And possibly edit it.

If you zoomed the LLM pane unzoom it now (`prefix + z`) and move focus to the Context Hub extension pane. You should see your new work item in the selection list of this pane. Hit enter when it is selected and the detail for that item will be shown. Since we are likely to want to edit some details don't zoom the pane, we want both panes present at the same time.

At the time of writing the detail view does not auto-update if edits are made. HIt `esc` to go back to the selection list and hit enter again to review the changed. 

Once you are happy with the brief we can move on. Focus on the LLM pane and type `/quit <enter>` to close it.

### Work Item Planning

Sometimes an intake is sufficiently detailed to allow implementation to occur straight away. This is especially true for small work items with minimal risk (notice that the LLM has identified the size of the work and the risk it presents). If you wanted to skip ahead to implementation you could hit `i` at this point, the system will evaluate whether the intake is sufficient and, if it feels it has enough information, will proceed straight to implementation (the next section). However, given that this is a core document in our game design journey we are not going to let the AI rush ahead. We will hit `p` for plan.

As before an LLM pane will open and the plan skill will be executed. This is a similar process to the intake but it focuses more on the "How?" and less on the "What?" and "Why?". Like the intake skill it will ask questions if there are any ambiguities in the intake. Again, answer them as fully as possible. Don't be afraid to ask the AI for quidance if you are unsure, you can even delegate a decision to the AI if you want to.

Note that for items that carry medium or higher risk, or are larger than small effort, the AI will ask for your approval of the outline plan. This is your opportunity to ask for high level changes to the plan. You will get another, more detailed, review opportunity when this phase is complete.

### Reviewing the Plan

As with the Intake the AI will output a summary of the plan when it is complete. If this is enough detail for you to proceed you can simply close this pane (`/quit`). If you want to review in more detail then move the focus to the selection list. If the planning phase created child work items you can expand the root item by hitting `tab`. You can inspect the details of each item by highlighting them and hitting `enter` as before.

You can ask the AI to make any edits you want to the plan using the LLM pane chat inteface. Once you are happy we can move on to implementation.

### Work Item Implementation

You may have noticed that work items are grouped in the selection list in Herdr. This grouping is file based. When two work items are predicted to touch the same file they will be placed into different groups. If you work with multiple agents this helps minimize conflicts between them. That is, assign agents work from different groups and they should not be working on the same file. Of course, agents will also use Git worktrees and will resolve any merge conflicts, but it never hurts to provide a helping hand like this.

Implementation is now as simple as selecting the parent work item and hitting `i`. You can, if you prefer, implement children one at a time, but there is no need to do so, especially on small, low risk work items. 

The quality of the results depends on how well you did the two previous steps. At the start of a project, when there is no history for the agent to work from, it is important to provide as much detail as possible. Hopefully the interview stages of the previous steps will have made the plan sufficiently detailed. But as with all aspects you have an opportunity to review before proceeding.

When the LLM has completed implementation a summary will be provided and the work item will be placed into the 'in_review' stage. You can decide whether you want to review in detail, or simply move on.

### Work Item Audits

During implementation the agents perform an audit. This checks to see if the work done actually matches the Acceptance Criteria defined during intake and planning. Theoretically this can always be trusted. In practice we find it makes sense to conduct a second, independent audit and, if necessary, a human audit too.

To have the agents perform a full review hit `a a` (audit - automatic) when focused on the item in the selection list. This will run the audit over the parent and children.  If it passes a green tick will be shown in the audit meta-data of the item. If it fails a red cross will be shown. In either case a full audit report is stored in the item. If the audit feels a producer review is warranted it will add a red cross under "reviewed" otherwise a green tick will be placed there. That is, if a producer review is required it assumes the producer has not reviewed, but if the agent believes there is no need it assumes the producer has reviewed. The producer can always record their own review using `a r` for 'audit reject' (a form will allow them to record the reason for the rejection). Or `a y` for `audit yes`.

Since the GDD is critical to the project and there is no executable code for us to run it is imperitive we review the document and make any edits necessary. The document is now a file on disk so you can use your favourite editor. In this case it is a markdown document so you can review it right inside Herdr by openeing the detail view for the work item and selecting the document at the top of the view and hitting `enter`.

We could, if we so desired, edit the GDD directly. However, this is discouraged because it does not provide any history of the change. LLMs are simply token predictors. If the LLM predicted a set of tokens that we need to change there is a strong chance that it will make the same prediction unless we guide it away from that result. This is where the Context Hub comes in.

When an agent is working on a work item it will consult documentation, code and other work items to prepare. So, imagine that the LLM had created a design for a level that does not fit your vision for the game. Rather than simply editing the GDD you should create a work item that describes what you do not like about it and, optionally, suggest an alternative (if you don't provide an alternative the AI will do so). In the future if you ask it to design a new level there is a reduced chance that it will use the same design principle that you already rejected.

This works for code too. If you see something you don't like about coding style or an implementation detail then create a work item describing the issue and requiring the AI to correct it. In fact, sometimes this will happen automatically for you as agents are instructed to look for refactoring smells and automatically file work items to correct them. There is also a refactoring skill which will do a full project review and create work items for you. The system will also automatically create work items for tests that are flaky and other similar work.

This isn't foolproof, of course, but we have found it to be very effective and certainly worth the effort. There's another added bonus too. At a later date you might decide it is a good idea to create a level design document that contains best practices and anti-patterns. If you keep all your guidance in work items then this becomes a relatively trivial excercise.

A little work up-front can pay off multiple times as the work progresses.

Assuming you created some work items to improve the GDD you should now work through each one in the same way as we did above. Alternatively, you can go for a walk or go to bed and let the Context Hub orchestrator progress the items for you. At the time of writing this only works with local LLMs, but it is relatively trivial to make it work with remote LLMs too, reach out to us and lets talk through a design.

### Automated Building

The Herdr plugin has a feature that will automatically run work items through this process. At the time of writing this only works if you have local LLMs setup using the proxy. There's no reason why we couldn't make it work with only remote, but one of our current design goals is to keep costs down by utilizing loal LLMs. We also don't want the LLM rushing forward with work items that are too large to be implemented unattended or introduce risk into the system. Therefore only a work items that match a defined size and risk tolerance will be automatically scheduled.

If the system encounters an ambiguity that it cannot work past then it will stop and record a question for the producer. So when the preoducer returns to their work they can unblock the item.

The way it works is that it queries the proxy to understand how busy the local LLM is. If capacity is available it will schedule a job. Simple as that. This is why it currently only works with local LLMs, remote LLMs have near unlimited capacity and thus jobs would simply be scheduled at will. This would run up quite a bill and thus we would need some kind of rate limiting system implemented, not hard to do, just something we've not done yet.

If you don't want the system automatically performing work then you can simply hit the `d` key and the information line at the top of the selection list will switch to saying "Downtime Off", which means no work will be scheduled.

## Complete Workflow

Once the GDD is ready we have a structure against which to build. At this point it may be tempting to simply tell the AI to "build this" and point to the GDD. If you are using a frontier model it will probably do a pretty good job. But that's not what we want. We want to be in control of what is built. We want to play it and refine the gameplay as we progress. We want to "find the fun" and that means taking it slowly and trying things out before committing to a particular path.

The previous sections stepped through an entire workflow but there is more to it than that. We can use the Context Hub to coordinate entire sprints, each of which will culminate in a fully tested release.

### Defining The First Code Deliverable

The first thing in any game design is to ensure that the thing the player does the most is fun. In a game like this the player does nothing but move. So lets start by creating our player and have them move around the screen. Nothing more. No menu's, no enemies, no powerups nothing. Just the player and the WASD/Arrow keys. The ships movement needs to be enjoyable in its own right.

It's also a good idea to create a "gym", a collection of scenes designed to allow easy testing of key mechanics. We will start the gym for this game now.

Earlier we hit `c` to open the create form and typed in the work item description. We could do the same again, but at the time of writing the editor in these forms is quite limited. So we will do it a different way this time. The `c` command simply creates a Pi session and injects the appropriate command. We can open a Pi session using `P n` (Pi new). 

To run the intake skill we use `/skill:intake` followed by the description of what you want in the work item. We will use "Create the first scene gym scene. This scene should contain nothing but the player ship. The player is able to move around the screen using the control keys. Movement should feel natural and simulate space movement. That is, when the player presses a direction key thrusters will fire to direct the ship in the chosen direction. It will take a short moment to slow and reverse any existing movement. This should not make the ship feel sluggish, but it should be enough to force the player to think ahead with respect to their movement. Asteroids is a good example of a game that does this."

When I ran this the AI pointed out that since there was no code in the project yet this work item would also include a project bootstrapping step. I told it that this should be a separate work item What it created for me was the requested item and a bootstrap work item. The player one was blocked by the bootstrap one.

### Managing Sprints and Releases

We will want to create the same kind of gym scenes for each of the enemies, we will also want to be able to test the power ups and ensure that we can actually collect them. We could do this within the game itself, as it comes together, or we could do it in gym scenes. While the AI is working on both the release and the player movement scene intake, lets give it something else to do. We will define a whole load of work items that can logically make up a single development sprint.

You could do the same as we did above, directly create a `/skill:intake` request for each. However, we don't want to fire up too many LLM requests all at once. If you are using local models this will clog up the model and slow it down, potentially falling back to paid models if you are using our proxy. If you are using remote models, or falling back to them when the local model is busy this can quickly rack up a big bill. You might want to go a little slower. To do this we will create idea work items using the CLI. These do not make LLM calls.

#### Enemy Gym scenes

```bash
wl create -t "Create Enemy Gym Scene work items" -d "Create a gym scene for each of the enemies in the GDD. The scene should clearly demonstrate the formation, movement, sprites, sounds etc. for the enemies. Each scene should have buttons to explode a random enemy (simulating it being shot) and another to toggle shoot behaviour on and off (for those that can shoot in later levels). Each scene should have its own work item. The first three enemies will be high priority items, the others will be medium."
```

#### Refactoring

```bash
wl create -t "Refactor Enemy Gym Scenes" -d "Create a work item to refactor the code produced for the first three enemy gym scenes. This refactoring will identify opportunities for code reuse accross the scenes and will create work items, of high priority, for extracting this reusable code into core libraries. Each gym scene will be rewritten to use the core libraries. A new document ENEMY_DESIGN_AND_IMPLEMENTATION.md will be created which will contain best practive recommendations for using these libraries. The remaining work items to create enemy gym scenes will be updated to adhere to these best practices. This refactor work item will be dependent on the first three enemy gym scenes and will be critical priority."
```  

#### Gym Index

```bash
wl create -t "Gym index scene" -d "Create an index scene for the Gym Scenes. This work item will be dependent upon the completion of the first enemy scene. It should be the entry page for the game when run in dev mode."
```

#### Gym Index Entry Scene

The gym index (`src/scenes/GymIndex.ts`, key `GymIndex`) is the **entry scene** for the project: `npm run dev` / `npm run preview` boot straight into it (it is the sole scene registered in `src/core/gameConfig.ts`). It lists every gym scene for isolated testing:

- **Discovery is directory-dynamic (AC3):** the index enumerates `src/scenes/gym/` via Vite's `import.meta.glob` (see `src/utils/gymDiscovery.ts`) — there is no hard-coded scene list. Drop a new `Gym<Name>.ts` file into the folder and it appears on the index automatically (picked up on dev-server restart/HMR or rebuild, since `import.meta.glob` resolves at build time). `.test.ts` files are excluded, and the index itself lives outside the folder (`src/scenes/`) so it is never listed.
- **Labels & ordering (AC4):** each entry's label strips the leading `Gym` from the file/class name (`GymScout` → `Scout`, `GymPlayer` → `Player`) and entries are sorted alphabetically. Selecting an entry starts that scene immediately by its class-name key (`this.scene.start('GymScout')`).
- **Back to the list (AC5):** every gym scene shows a shared "← INDEX" button (`src/utils/gymNavigation.ts`) that switches back to `GymIndex` — no reload needed.

#### Adding a New Gym Scene (convention)

1. Create `src/scenes/gym/Gym<Name>.ts` with `export class Gym<Name> extends Phaser.Scene` (key `Gym<Name>`). No registry edit needed — the index discovers it automatically.
2. In `create()`, call `addBackToIndexButton(this)` (from `src/utils/gymNavigation.ts`) so the scene can return to the index.
3. Add a `Gym<Name>.test.ts` next to it (excluded from the index automatically).

#### E1 Scout Gym Scene

The first enemy gym scene (Create E1 Scout gym scene) is a standalone Phaser scene demonstrating the E1 Scout (GDD §4.1):

- `src/entities/Scout.ts` — the Scout entity: a small neon-green chevron (`#00ff00`) that flies in a V-formation, fires aimed shots at a target position when shoot mode is enabled (simulating its level 4+ behaviour), and plays an explosion animation on destruction. Scouts are 1 HP and never collide with each other (GDD §2.6) — no collision system is installed.
- `src/scenes/gym/GymScout.ts` — the gym scene: spawns a 6-scout V-formation that advances across the screen, with two on-screen controls: `EXPLODE` (destroys a random scout) and `SHOOT: ON/OFF` (toggles aimed firing at the bottom-centre of the screen, standing in for the player).
- `src/audio/effects.ts` — procedural WebAudio sound cues (spawn blip, destruction burst), safe no-ops when no audio context exists (e.g. headless tests).

The scene is reachable from the gym index ("Scout" entry) and returns to it via the "← INDEX" button — it is a gym testbed (no player ship, no HUD, no power-ups, no other enemies). Coverage: `src/entities/Scout.test.ts` + `src/scenes/gym/GymScout.test.ts` verify formation geometry, movement, explosion, shoot toggle and aimed-bullet behaviour.

> **Graphics style gotcha (browser rendering):** Phaser `Graphics` is command-buffered, and `clear()` wipes any styles (line/fill) queued before it — it only re-applies the default white 1px stroke. Entity bodies must therefore call `lineStyle()` **after** `clear()` inside `_drawBody()`; the original Scout code styled before clearing, so the chevrons stroked with the default style and rendered invisible in a real browser (no console error, and headless tests stayed green). `src/entities/Scout.test.ts` regression-tests the stroke style ordering via the command buffer; visual confirmation is a manual `npm run dev` step (formation should show as neon-green chevrons).

#### E5 Swarm Gym Scene

The E5 Swarm gym scene (Create E5 Swarm gym scene) is a standalone Phaser scene demonstrating the E5 Swarm (GDD §4.1) — the fast-moving, unpredictable cluster attacker. It builds on the shared `GymFormationScene` core library and the cluster offset builder in `src/utils/formations.ts`:

- `src/entities/Swarm.ts` — the Swarm entity: a small diamond-shaped neon-blue (`#0066ff`) entity that moves in tight, fast-moving clusters with sudden direction changes. Members weave around their formation slot with a bounded per-cluster drift (clusters of 3–5, GDD §4.1), so packs stay together but can split and rejoin. At Level 4+ (shoot mode) members fire coordinated burst volleys toward the bottom-centre target; 1 HP, explosion on destruction, no collisions (GDD §2.6).
- `src/scenes/gym/GymSwarm.ts` — the gym scene: a thin `GymFormationScene` subclass spawning a 15-member swarm in ~3 clusters, with the standard `EXPLODE` and `SHOOT: ON/OFF` controls.
- `src/utils/formations.ts` — `buildSwarmClusterOffsets` (and the `SWARM_CLUSTER_ROW_STRIDE` constant) generate the deterministic cluster geometry for 3–5-member packs.

The scene is reachable from the gym index ("Swarm" entry) and returns to it via the "← INDEX" button. Coverage: `src/entities/Swarm.test.ts` + `src/scenes/gym/GymSwarm.test.ts` verify cluster geometry, drift bounds, pass-through (no collision), explode, shoot toggle and coordinated burst speed.

#### GymPowerUps Gym Scene

The GymPowerUps gym scene (Create gym scene for power-ups with spawning, collection, and standalone HUD) is a **threat-free** Phaser scene demonstrating power-up spawning, collection and HUD feedback for the non-combat power-ups P5 Speed Boost, P8 Extra Life and P9 Magnet (GDD §4.4):

- `src/powerups/PowerUp.ts` — base drop class: delta-time grow → hold → shrink → despawn lifecycle, round-robin spawner (P5 → P8 → P9), collection gated at **>3%** of full-size scale.
- `src/powerups/types.ts` — power-up catalogue (id, name, type, duration/stack semantics) for P5/P8/P9.
- `src/powerups/effects.ts` — engine-agnostic active-effects registry: P5 timed +50% speed (refresh on re-collect, never additive), P8 lives (start 3, cap 5), P9 permanent magnet stacks (cap 5; radius `2× ship size + 50% per stack`; attraction at `MAGNET_ATTRACTION_SPEED`, slower than ship max speed).
- `src/powerups/icons.ts` — code-drawn neon icons shared by field drops and the HUD (no external art assets).
- `src/ui/HUD.ts` — **standalone HUD** (Phaser Container, depth above gameplay) attachable to any scene: per-effect rows (icon, name, remaining-seconds timer or `xN` stack count) plus a lives counter.
- `src/scenes/gym/GymPowerUps.ts` — the scene: round-robin spawning (one drop per 5 s, 5 s lifetime → the next spawn coincides with the previous despawn), overlap collection gated at >3% scale, magnet attraction, live P5 speed multiplier on the ship, HUD attachment, and the shared "← INDEX" back button.

The scene is reachable from the gym index ("PowerUps" entry). It is reused as the shared power-up lifecycle/HUD foundation by the combat power-up gym. Coverage: `src/powerups/*.test.ts` + `src/scenes/gym/GymPowerUps.test.ts` (+ `HUD.test.ts`) verify lifecycle timing, round-robin order, threshold, effect semantics, HUD model and scene behaviour.

#### GymWeapons Gym Scene

The GymWeapons gym scene (Weapon power-ups (3 patterns + reset) with auto-fire and weapon gym scene) gives the player ship its first real weapon — auto-fire (GDD §2.3) plus three weapon power-ups and a Reset (GDD §4.4, persistent semantics per operator):

- `src/utils/weapons.ts` — pure, unit-testable weapon catalogue: `cannon` (single bullet), `spread` (3-bullet fan at -30°/0°/+30°), `dual` (2 bullets perpendicular to heading), `rapid` (single bullets at a markedly higher rate) — each with its own fire rate, bullet colour/shape — plus heading math (`headingFromVelocity`, `absoluteAngle`, `computeHeading` — most-recent-heading fallback when stationary) and scene-facing helpers (`createBulletsFromHeading`, `angleToVelocity`).
- `src/entities/Player.ts` — auto-fire weapon slot on the ship: `equipWeapon(id)` / `resetWeapon()` (**persistent** — no timer, AC2), `getHeading()`, fire cooldown (`tryFire`).
- `src/entities/PlayerBullet.ts` — Graphics-drawn player bullet (`vx`/`vy`, filled circle), created via `createPlayerBullet` and culled off-screen via `advanceAndCull` (no physics bodies, matching the ScoutBullet precedent).
- `src/powerups/icons.ts` — distinctive code-drawn weapon icons (fan arc for Spread, parallel bars for Dual, waveform for Rapid, return/undo arrow for Reset); `src/audio/effects.ts` — spawn/despawn/collection/weapon-change cues (Web Audio synthesis, safe no-op fallback).
- `src/scenes/gym/GymWeapons.ts` — the scene: ship + auto-fire + round-robin weapon-drop spawner (**Spread → Dual → Rapid → Reset**, one drop at a time, 7 s lifetime — parameterised via `WEAPON_DROP_LIFETIME`, sharing the `PowerUp` grow/hold/shrink lifecycle with the 5 s non-combat gym), collection gated at ≥3% scale, persistent weapon switching, and the shared "← INDEX" back button.

The scene is reachable from the gym index ("Weapons" entry). Coverage: `src/utils/weapons.test.ts` (pattern math, fire rates, round-robin order, heading fallback) + `src/scenes/gym/GymWeapons.test.ts` (auto-discovery, ship presence, auto-fire, persistent switching/reset, round-robin, grow/shrink, collection gating) + `src/entities/Player.test.ts` (heading/equip/auto-fire behaviours).

### Prioritizing work

At this point we have a number of work items. How do we know which to work on first, and how will the AI decide which to dispatch in downtime?

The worklog CLI has a handy command `wl next` (use `wl next --help`) which drives the selection list in the Herdr UI. This uses a complex algorithm to decide which n work items should be worked on next. It takes into account item stage, priority, dependencies, age and much more. What this means is that the work items listed in your selection list in Herdr are the ones that should be worked on next and, generally speaking, the ones at the top of the list should be done first. 

You'll also notice that they are broken into groups. The first set of groups are items that are plan or intake complete. These are broken into sub-groups. Generally speaking it is safe to work on one item in each sub-group. There's no guarantee of no conflict, but the AI does its best to avoid problems. The next group is the "idea" group, these are items the AI is not yet able to place into an implementation group, they must go through the intake process first. Finally there is the "In Review" group, these are waiting to be audited and approved by the producer, ready for release.

The one exception to this rule is the Critical group. Any items marked as critical priority and not yet implemented will appear here (at the top) regardless of their stage. You should always address critical items first. 

Note that blocked items (that are not critical) will not appear in the Context Hub, but items that block other items will appear in an appropriate ordering, for example, a medium work item that blocks a high priority item will appear higher than a medium that is not blocking anything.

In the previous sections we created a number of ideas and performed an intake for the player gym scene. We didn't specify a priority, so these will all be marked as medium. However, the Bootsrapping item is on the critical path and thus will appear first in the list. We can run that through the intake, plan and implement phases now. While it is working we can run intake on the enemy gym scenes work item.

This intake will create another bunch of work items, one for each of the enemy gym scenes. The refactor work-tem, when intake is complete, will be marked high priority and be blocked on the first three enemy gym scenes. This will mean the first three gym scenes are guaranteed to be prioritised above the others. In addition, since the refactor is high priority and the remaining gym scenes are medium the refactor work item will be placed higher in the priority, once unblocked, than the remaining work items.

This orderting will be true for both the producer and Context Hub when dispatching work, though the human can override if they feel it is appropriate. In other words, I could go to bed at this point and when I wake up the project will have progressed nicely.

### How much work per sprint?

You can control how many work items are displayed in the Context Hub, which we find is a convenient way of defining the deliverables in a sprint. This approach doesn't use story points or similar metrics, and thus is not optimal if your goal is to release on a predictable schedule. However, we like the approach and so it's what we have (though it is worth noting that the system does have effort and risk estimates which means it would be "trivial" to do time estimated sprint planning).

Note that regardless of how many items you configure to display if there are any critical items they will always be displayed. So you may sometimes find more than the configured number. 

### Ship It!

Once all the work items in a sprint have been implemented we have an optimal time to create a release. So lets do it, using the `Ship` skill.

The ship skill will ensure all work items that are in_review have been fully audited and have been signed off by a producer. If any problems are discovered during this process they will be handled automatically or raised for producer attention, depending on the issue type and severity. It will also ensure that no critical work item is outstanding. Once the checks are complete a release is cut, pushed to git and tagged. Version numbers are increased and we can start work on the next sprint.

To run a release hit `S`, a dialog will appear asking you to confirm the intention is to ship (by typing `ship`). Alternatively, as with all actions carried out from the Context Hub, you can ask your agents in chat with somethiung like "Ship It".

Once the ship process starts the project is put into a code freeze mode. The scheduler will no longer schedule implementation work, though intakes and planning work items will still be dispatched. This means that while the (sometimes time consuming) QA processes are running we can continue to add work items for the development of the game. 

## Local versus Remote LLM

Local LLMs (for most of us) are slower but cheaper, remote LLMs are more expensive, but faster. I find that many people believe their AIs need to be super responsive, but I disagree (which is handy because I can't afford big AI bills). However, I do want them to be faster when I'm actively working with them. When I'm asleep I want them working, but I'm not as worried about speed. This means that I can save money with slower local LLMs overnight while leveraging paid models alongside the local LLMS during the day.

This is where the LLM Manager proxy comes in. The proxy has a number of important features for managing local vs remote work. The goal is to bring as much work as possible to the local LLM, while also enabling the use of remote LLMs to keep things moving at a pace. 

The most important feature in this regard is the ability to route traffic dynamically to local (cheap and slow) models or remote (fast and more expensive). By dynamically I mean the proxy, with the help of the context hub, adapts to circumstances. For example, if the system detects that there is no human working with the AIs right now it will reconfigure things to send more work to the proxy, e.g. it will reduce the number of slots available, therefore allowing a larger context, therefore reducing the number of work items that fall back to remote LLMs. If the system detects a human is present, e.g. a human manually enters a command into the Context Hub, then the proxy will switch to a faster mode that has more local slots, but with smaller contexts. This results in more simultaneous jobs, but with more frequent fallback to remote LLMS.

Once the proxy is configured you get all this for free, and more. For example, you can define fallback chains of models that will seek the cheapest available remote model for you. Control of what models are available and when is provided through a number of mechanisms, such as they can be timed, so you can take advantage of off-peak charging available from some providers or token budget based.