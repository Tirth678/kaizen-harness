# Kaizen Code 1.0

**An agent made for you. Only you.**

Kaizen Code 1.0 by **FlinT Labs** is a terminal-native coding agent designed to work alongside you, directly where you build.

Instead of jumping between your editor, browser, documentation, and a separate AI chat, Kaizen lives in your terminal and works with your codebase through tools.

You describe what you want.

Kaizen explores the project, reads the relevant files, runs commands, makes changes, observes what happened, and continues until the task is complete.

---

## Why Kaizen-code?

Coding agents are becoming more capable, but the experience can still feel like you're adapting your workflow around the AI.

Kaizen takes the opposite approach.

**Your terminal. Your codebase. Your workflow. Your agent.**

The goal isn't to build another chatbot that happens to write code.

The goal is to build an agent that can **operate**.

```text
You
 │
 │  "Find why the tests are failing and fix it."
 ▼
Kaizen
 │
 ├── searches the codebase
 ├── reads relevant files
 ├── investigates the failure
 ├── edits the code
 ├── runs the tests
 ├── observes the result
 └── keeps going when something fails
 │
 ▼
Done
```

---

## What can Kaizen do?

Kaizen is built around the idea that an AI coding agent should be able to **see, act, and verify**.

### Explore your codebase

Ask questions like:

```text
> Where is authentication handled?

> Find all the places where the database client is initialized.

> Explain how requests flow through this project.
```

Kaizen can inspect your files and use the terminal to understand the project before making changes.

### Make changes

```text
> Add rate limiting to the API.

> Refactor this function without changing its behavior.

> Fix the TypeScript errors in this module.
```

Kaizen can use filesystem and editing tools to make changes directly in your working directory.

### Run and verify

```text
> Fix the failing tests.

> Build the project and resolve any errors.

> Run the linter and fix what it finds.
```

The agent can execute commands, inspect their output, and use the results to decide what to do next.

### Recover from failures

A failed command doesn't necessarily mean the task is over.

```text
edit
  ↓
test
  ↓
failure
  ↓
inspect error
  ↓
adjust
  ↓
test again
```

Kaizen is built around this iterative loop.

---

# The core idea

At the heart of Kaizen is a simple agent loop:

```text
User Request
     ↓
    Model
     ↓
  Tool Call
     ↓
   Execute
     ↓
 Tool Result
     ↓
    Model
     ↓
  Tool Call
     ↓
     ...
     ↓
 Final Result
```

The model decides **what to do**.

The tool layer handles **how to do it**.

Keeping those responsibilities separate gives Kaizen a foundation that can evolve without turning the agent into a tightly coupled collection of scripts.

---

# Designed for the terminal

Kaizen is not an IDE plugin pretending to be a terminal application.

The terminal is the environment.

That means Kaizen is designed around the things developers already use every day:

* files
* directories
* shell commands
* git
* tests
* compilers
* package managers
* build systems
* development environments

You can stay in the same environment where you already work.

```bash
kaizen
```

Then:

```text
> fix the authentication bug
```

---

# Built around tools

Kaizen doesn't need to "know" every operation itself.

Instead, the agent is given a set of tools it can use.

The initial tool layer is focused on the fundamentals:

```text
read_file
write_file
edit_file
list_directory
search_files
run_command
```

This keeps the agent architecture simple while giving it enough capability to work on real software projects.

More tools can be added without fundamentally changing the agent loop.

---

# A simple example

Imagine you start with a failing application
