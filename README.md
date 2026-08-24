# AI Hell - Building A Game with AI Assistance

AI Hell is a classic "Bullet Hell" game written to demonstrate the use of the Context Hub AI framework designed and optimized for using local LLM to assist with coding games (though there's no reason why it can't be used for other types of projects too).

The goal here is not a fully releasable game, but rather a tutorial on how to use the AI Framworks. It's written by humans for a technical target audience, i.e. very little explanation, just instructions. There are extensive AI maintained docs in the code projects referenced here. Point your AI at this as a starting point and ask it questions if you are confused. 

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

The proxy is a smart routing system that will help you optimize local vs remote LLMs. It's not absolutely necessary, in fact if you intend to work with a single remote model then you may as well skip this step. If you are working with multiple remote models it can provide some useful features, but we recommend skipping it at first. However, if you are using a local LLM alongside remote LLMs it's highly recommended for many reasons (model fallback when busy, error recovery, automatic switching between fast and cheap modes and much more).

  FIXME: As things stand in the herdr plugin right now model names in the shortcuts are assumed to be plan, audit and code. It is unlikely someone working without the proxy will have these setup. We either need a config in the herdr plugin or instructions to use and configure the proxy. For now, users can manually edit the models defined in `packages/herdr/src/shortcuts.json`

  FIXME: Complete the Proxy setup instructions

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

We will start by creating a `docs/Game Design Document.md` that will have our initial design for the game. Note, however, we will not start by immediately writing the document, instead we will create a work item to track its creattion. This is important as the worklog becomes the systems memory. If we simply create the document agents will know the file exists and will read it. But they will not know the decision making process that led to the file looking as it does. Knowing this history is important as it avoids repeating errors or asking the same question muiltiple times.

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
wl create -t "Write a complete Game Design Document for AI Hell" -d "We need a fully detailed Game Design Document for a game with the working title of AI Hell. This will be a 2D bullet hell game loosely based on the classic arcade game Galaxians." 
```

There are many more command line parameters that can be provided, us `wl create --help` to list them.

### Work Item Intake

Since we have time right now we will skip the idea step and go straight to the work item intake. To do this we will ensure the Herdr Workload plugin has focus and press `c` for create new. 

```
c
```

This will open a simple form in which you can enter the description of the work item you want to create. You don't need to create a title as this is going to be fed to an LLM so that the intake skill will be run against it. In this form you can also set a priority (critical, high, medium, low), this can be done in the cli with the `--priority` parameter.

Type the same description as we used in the previous section into the form and hit enter.

  If you had entered the idea using the cli, that idea would be listed in the plugin and you could hit `n` for intake (we will use `i` for implement later). 

This will open a new pane in herder and start the intake skill. The skill will ask a series of interview questions to help it create the GDD. Note that these questions are not a part of the skill, so each time you run it the questions asked may be different. Answer the questions with as much or as little detail as you like. 

There is something important to note about this process. The system doesn't just use the information in the work item to understand the ask. It will also search the worklog, documentation and code for useful information. This will be supplied to the LLM as context. In this case the LLM has read this very README.md (which I am writing as I record a video of the process). The system read it and noted that:

```markdown
Potentially related docs/paths: (none exist yet — this is the first artifact)
 - README.md — Informs the GDD: the game is "a classic Bullet Hell game written to demonstrate
   the use of the Context Hub AI framework," built "by humans for a technical target
   audience," and the GDD location is planned as docs/Game Design Document.md. It also states
   the workflow stage chain (Idea → Intake → Plan → In Review → Release).
```

Note that my work item description did not include the location or filename of the document. It has grabbed this information from the README.md file. It also noticed that the purpose of this game is to demonstrate the use of the Context Hub AI framework and it recognizes that the audience is technical. This information will help guide the GDD interview questions. 

There are plenty of opportunities to adjust this later, so don't worry about the AI taking creative control of the game. It's a good idea to leave some space in the design, sometimes the AI has good "ideas", but you should make sure you nail the core gameplay loop in sufficient detail to ensure the game built is the one you envision. 

  HINT: you can 'zoom' into any pane by giving it focus and hitting `prefix + z`, to "unzoom" use the same shortcut.

### Reviewing the Intake Brief

The output of the intake process is a brief that is stored in the work item description. The LLM will output a summary to in the Herdr pane we are working in, sometimes this will be enough information to fully review the work. However, for something as large and critical as a Game Design Document we are going to want to review the output in detail. And possibly edit it.

If you zoomed the LLM pane unzoom it now (`prefix + z`) and move focus to the Context Hub extension pane. You should see your new work item in the selection list of this pane. Hit enter when it is selected and the detail for that item will be shown. Since we are likely to want to edit some details don't zoom the pane, we want both panes present at the same time.

At the time of writing the detail view does not auto-update if edits are made. HIt `esc` to go back to the selection list and hit enter again to review the changed. 

