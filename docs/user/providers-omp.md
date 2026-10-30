# Oh My Pi

T3 Code runs your existing [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) installation
over its ACP mode. Your omp models, credentials, settings, skills, and session history carry over.

## Set Up Oh My Pi

1. Install omp on the machine running the T3 Code server. T3 Code is tested with omp 18.14.0.
2. Run `omp` in a terminal, then `/login` to connect a model provider or configure its API key.
3. Open **Settings → Providers**, enable Oh My Pi, and refresh the provider.

If `omp` is not on the server's `PATH`, set **Binary path** to the executable. Set **Profile** to
run an omp profile with its own credentials, sessions, and settings. Add another Oh My Pi instance
to use a second profile side by side. Log in to a profile with `omp --profile <name>`, then `/login`.

**Update now** runs `omp update` unless a package manager owns the installation.

## What Carries Over

The model picker lists every model omp can use with its current credentials, with each model's
thinking levels and omp's **Auto** thinking. **omp default** runs omp's own default model role, even
in a thread that ran another model earlier. omp keeps native session history, so threads resume
and fork within the same instance. Switching providers uses portable conversation context.

Questions from omp's `ask` tool and extension dialogs appear in the composer. `/compact` compacts
the omp session. T3 Code's tools reach omp as an MCP server.

## Permission Modes

T3 Code starts omp with the approval mode that matches the thread, so omp enforces it:

- **Supervised** asks before commands and file changes.
- **Auto-accept edits** applies file changes and asks before commands.
- **Full access** runs tools without approval prompts.

**Auto** is not offered. Command approvals appear as approval requests. File change approvals
appear as a question with omp's own choices, such as **Approve edit for this session**. omp still
asks about restricted folders and critical commands in **Full access**. Changing the mode restarts
the omp session and resumes the same conversation.

## Troubleshooting

- If no models appear, run the configured binary with the same profile on the server and check
  `/login`, then refresh the provider.
- If model discovery fails, T3 Code keeps Oh My Pi available with **omp default**. The live session
  uses omp's own model list.
