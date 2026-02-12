# openclaw-agent

Deploy your own OpenClaw AI agent in minutes.

## Quick Start

```bash
git clone https://github.com/ihorkatkov/openclaw-agent-bootstrap.git
cd openclaw-agent-bootstrap
./setup.sh
```

The setup script checks prerequisites, builds (or verifies) the OpenClaw image, runs interactive onboarding, and starts your gateway.

Security note: `.env` and `.openclaw/` contain credentials and are gitignored.

## Prerequisites

- Docker Desktop (macOS) or Docker Engine + Compose v2 (Linux)
- Git (if you plan to build the image from OpenClaw source)
- About 5 minutes
- Provider credentials for at least one model provider (Anthropic, OpenAI, or another OpenClaw-supported provider)

## What `./setup.sh` Does

1. Asks for your agent name (`COMPOSE_PROJECT_NAME`)
2. Optionally builds an OpenClaw Docker image from a local source checkout
3. Generates a secure gateway token
4. Creates local runtime directories (`.openclaw/`)
5. Writes a local `.env` file (mode `600`)
6. Runs interactive onboarding:
   - Provider selection (Anthropic, OpenAI, Google, xAI, and more)
   - Authentication setup (API key, OAuth, or setup-token where supported)
   - Model selection
   - Channel setup (Telegram, WhatsApp, Discord, Signal)
7. Starts the gateway container

## Provider Options

### Anthropic (recommended)

- API key: https://console.anthropic.com/
- Setup token: run `claude setup-token` and paste it in onboarding
- Example model: `anthropic/claude-sonnet-4-5`

### OpenAI

- API key: https://platform.openai.com/api-keys
- OAuth (Codex login): supported directly in onboarding when available
- Example model: `openai/gpt-4o`

## Telegram Setup (BotFather)

1. Open Telegram and message `@BotFather`
2. Send `/newbot` and follow prompts
3. Copy the bot token
4. During onboarding, choose Telegram and paste the token
5. In Telegram, send `/start` to your bot

If the bot does not answer, check token validity and gateway logs (`make logs`).

## Daily Usage

```bash
make start
make stop
make restart
make logs
make status
make shell
```

## Configuration

- Re-run onboarding: `make onboard`
- Set active model: `make cli CMD="models set anthropic/claude-opus-4-6"`
- Add channel later: `make cli CMD="channels add --channel telegram --token <token>"`
- Show model config: `make cli CMD="models status"`

## Network Access

- Default setup keeps host binding on `127.0.0.1`
- For LAN/Tailscale access, re-run `./setup.sh` and choose all-interface exposure
- You can also edit `.env` and set `OPENCLAW_GATEWAY_HOST=0.0.0.0`

If you expose the gateway beyond localhost, use strong gateway auth and trusted networks.

## Troubleshooting

- If setup fails, run `make doctor`
- On fresh clone, `make doctor` should fail on missing `.env` until you run `./setup.sh`
- Image build failures: confirm Docker is running and you have enough disk space
- Telegram not responding: verify token and send `/start` to the bot
- Port conflicts: change `OPENCLAW_GATEWAY_PORT` in `.env`
- Safe reset: rerun `./setup.sh`

## Project Structure

After setup:

```text
openclaw-agent/
|- docker-compose.yml
|- setup.sh
|- Makefile
|- README.md
|- .env                # generated, gitignored
`- .openclaw/          # generated, gitignored
   |- openclaw.json
   |- .env
   |- agents/
   `- workspace/
```

## How It Works

OpenClaw runs as a gateway service in Docker. The gateway receives messages from configured channels, routes tasks to configured model providers, and executes agent workflows using the local OpenClaw config and workspace.

## Acknowledgments

- OpenClaw project: https://github.com/openclaw/openclaw
- OpenClaw docs: https://docs.openclaw.ai

## License

MIT (`LICENSE`)
