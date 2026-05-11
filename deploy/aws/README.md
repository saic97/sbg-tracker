# AWS deploy artifacts

| File | Purpose |
| --- | --- |
| `user-data.sh` | Pasted into EC2 "User data" at instance launch. Installs Node, clones the repo, runs migrations, starts systemd service. |
| `sbg-tracker.service` | systemd unit -- copied to `/etc/systemd/system/` by `user-data.sh`. |
| `Caddyfile` | Reverse proxy for HTTPS. Optional. |

Walkthrough: see [`docs/aws-setup.md`](../../docs/aws-setup.md).

## Required GitHub repository secrets

For `.github/workflows/backend-deploy.yml` to work, add these in
**Settings -> Secrets and variables -> Actions**:

| Secret | Value |
| --- | --- |
| `AWS_HOST` | Public IPv4 DNS of your EC2 instance (e.g. `ec2-1-2-3-4.compute.amazonaws.com`) |
| `AWS_USER` | `ec2-user` (default on Amazon Linux 2023) |
| `AWS_SSH_KEY` | Full contents of the `.pem` you downloaded at instance launch |

## Required GitHub repository variable

For the Pages frontend to talk to your EC2 backend, add this in
**Settings -> Secrets and variables -> Actions -> Variables**:

| Variable | Value |
| --- | --- |
| `API_BASE` | `http://<your-public-dns>:3001` (or your HTTPS domain if you set one up) |

## What the deploy workflow does on every push to main

1. SSHes into the instance.
2. `git pull --ff-only origin main` as the `sbg` user.
3. `npm ci --omit=dev` to update dependencies.
4. `npm run migrate` to apply any new schema migrations.
5. `systemctl restart sbg-tracker`.
6. Curls `/api/health` to confirm the service is responding.

## Optional: AI sub bid email intake

The Sub Bid Inbox feature needs both Claude and mailbox credentials on the EC2
host. Add these to `/etc/sbg-tracker.env`, then restart the service:

```bash
ANTHROPIC_API_KEY=...
BID_INTAKE_IMAP_HOST=outlook.office365.com
BID_INTAKE_IMAP_PORT=993
BID_INTAKE_IMAP_TLS=true
BID_INTAKE_IMAP_USER=bids@sourcebuild.net
BID_INTAKE_IMAP_PASSWORD=...
BID_INTAKE_IMAP_MAILBOX=INBOX
```

Manual "Check Inbox" from a project pulls unseen PDF attachments into that
project. For unattended polling, also set `BID_INTAKE_AUTO_POLL=1`; forwarded
email subjects should include `[SBG:<projectId>]` unless
`BID_INTAKE_DEFAULT_PROJECT_ID` is set for a single-project bid day.
