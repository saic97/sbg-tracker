# AWS deployment walkthrough

Goal: host the SBG Tracker backend (and optionally serve the frontend from
the same box) on a free-tier AWS EC2 instance, with auto-deploy from `main`.

**Time required:** ~20 minutes.
**Cost:** $0 for 12 months from your AWS account creation. After that,
~$8-10/month for the t3.micro + EBS unless you migrate or shut down.
**Region:** any. Pick the one closest to your office for best latency.

## Prerequisites

- An AWS account (you have one).
- The repo pushed to GitHub at `https://github.com/saic97/sbg-tracker`.
- Optional: a domain name you can point at the instance (for HTTPS). Plain
  HTTP works fine for an internal tool.

## Step 1 -- Launch the EC2 instance

1. Open the EC2 console -> **Launch instances**.
2. **Name:** `sbg-tracker`
3. **AMI:** Amazon Linux 2023 (free-tier-eligible, default selection).
4. **Instance type:** `t3.micro` -- look for the **"Free tier eligible"** label.
   - On accounts that don't have t3.micro free, fall back to `t2.micro`.
5. **Key pair:**
   - If you don't have one, click **Create new key pair**.
   - Name it `sbg-tracker-key`. Type: RSA. Format: `.pem`.
   - **Download the .pem file and keep it somewhere safe -- you can't redownload it.**
6. **Network settings:**
   - VPC: default.
   - **Allow SSH traffic from**: My IP (recommended) or Anywhere if your IP changes.
   - **Allow HTTP traffic from the internet**: yes.
   - **Allow HTTPS traffic from the internet**: yes (if you'll use a domain).
   - We also need port **3001** open. Click **Edit** in the Network settings
     section, then **Add security group rule**:
     - Type: Custom TCP
     - Port: 3001
     - Source: Anywhere (0.0.0.0/0) -- or My IP for a stricter setup.
7. **Storage:** 8 GB gp3 (default, free-tier-eligible).
8. **Advanced details -> User data:** open the text area at the bottom and
   paste the entire contents of `deploy/aws/user-data.sh` from this repo.
   That script installs Node, clones the repo, installs deps, runs
   migrations, and starts the systemd service automatically on first boot.
9. Click **Launch instance**.

Wait ~3 minutes. Refresh the instances list. Status check should go to "2/2".

## Step 2 -- Verify the backend is running

Click your instance, copy the **Public IPv4 DNS** (e.g.
`ec2-1-2-3-4.compute.amazonaws.com`). In a browser:

```
http://<your-public-dns>:3001/api/health
```

Should return: `{"ok":true,"ts":...}`.

If it doesn't:
- Check the instance's **System log** (Actions -> Monitor and troubleshoot ->
  Get system log). Search for `[user-data]`. Errors there will tell you
  what failed.
- Common issue: the user-data script needs ~2 minutes to finish on first
  boot. Try again in a moment.
- Security group: make sure port 3001 is actually open from your IP.

## Step 3 -- Point the Pages site at your backend

In your GitHub repo:

1. Go to **Settings -> Secrets and variables -> Actions -> Variables**.
2. Click **New repository variable**.
3. Name: `API_BASE`. Value: `http://<your-public-dns>:3001` (no trailing slash).
4. Save.

Now go to **Actions -> Deploy frontend to GitHub Pages -> Run workflow ->
Run workflow** to redeploy. The workflow will rewrite `<meta name="api-base">`
to your EC2 URL and flip `api-enabled` back to `true`. After ~30 seconds,
<https://saic97.github.io/sbg-tracker/> will be a live multi-device app
talking to your backend.

## Step 4 -- Wire up auto-deploy on every push

Three secrets need to be added so the `Deploy backend to AWS EC2` workflow
can SSH in:

1. **Settings -> Secrets and variables -> Actions -> Secrets -> New repository secret.**
2. Add:
   - `AWS_HOST` = the Public IPv4 DNS (e.g. `ec2-1-2-3-4.compute.amazonaws.com`)
   - `AWS_USER` = `ec2-user`  (the default user on Amazon Linux 2023)
   - `AWS_SSH_KEY` = the **entire contents** of the `.pem` file you
     downloaded at instance launch. Open it in Notepad and paste it all,
     including `-----BEGIN RSA PRIVATE KEY-----` / `-----END RSA PRIVATE KEY-----`.
3. The workflow will run automatically on the next push to `main` that
   touches `backend/`, `frontend/`, or `deploy/aws/`. You can also trigger
   it manually from the Actions tab.

The workflow:
- SSHes into the instance.
- Pulls the latest code as the `sbg` user.
- Reinstalls dependencies.
- Runs `npm run migrate` (idempotent -- it only applies new migrations).
- Restarts the systemd service.
- Hits `/api/health` to confirm.

## Step 5 (optional) -- HTTPS via a domain name

Plain HTTP on port 3001 is fine for an internal tool. If you want HTTPS:

1. Buy/own a domain (Route 53, Namecheap, Cloudflare -- doesn't matter).
2. Add an A record: `tracker.yourdomain.com` -> your instance's public IP.
3. SSH in:
   ```bash
   ssh -i sbg-tracker-key.pem ec2-user@<public-dns>
   sudo bash -c 'echo "CADDY_DOMAIN=tracker.yourdomain.com" >> /etc/sbg-tracker.env'
   sudo systemctl restart caddy
   ```
4. Caddy auto-fetches a Let's Encrypt cert. Your site is now at
   `https://tracker.yourdomain.com` (Caddy reverse-proxies port 443 to
   3001). Update the `API_BASE` repo variable to the HTTPS URL.

## Step 6 -- Backups

SQLite is one file. Two simple options, in order of effort:

- **Manual:** every so often, SSH in and `scp /opt/sbg-tracker/backend/data/sbg-tracker.db` to your laptop.
- **Automated to S3:** add a cron job that runs `aws s3 cp` nightly.
  S3 free tier is 5 GB for 12 months; the database will be < 100 MB for
  many years.

I haven't wired up automated backups yet -- ask if you want them.

## Costs after the 12-month free tier expires

- **t3.micro on-demand**: ~$7.50/month (us-east-1).
- **EBS 8 GB gp3**: ~$0.64/month.
- **Data transfer out**: 100 GB free per month, then ~$0.09/GB.

So **~$8.20/month**, predictable. If that's too much, the same workload runs
on a $5 Hetzner CPX10 or $6 DigitalOcean droplet with one config change in
this guide (different SSH details, same systemd unit).

## Troubleshooting

**`systemctl status sbg-tracker` shows "failed"**

```bash
sudo journalctl -u sbg-tracker -n 50 --no-pager
```

Common causes: port already in use, missing `npm install`, migration
syntax error.

**Pages site can't talk to the backend (CORS error in console)**

The default `CORS_ORIGINS=*` in `sbg-tracker.service` should make this work.
If it doesn't, edit `/etc/sbg-tracker.env`:

```
CORS_ORIGINS=https://saic97.github.io
```

Then `sudo systemctl restart sbg-tracker`.

**Sub Bid Inbox says "Inbox not configured"**

Add the mailbox settings to `/etc/sbg-tracker.env` on EC2:

```bash
sudo nano /etc/sbg-tracker.env
```

Include:

```bash
ANTHROPIC_API_KEY=...
BID_INTAKE_IMAP_HOST=outlook.office365.com
BID_INTAKE_IMAP_USER=bids@sourcebuild.net
BID_INTAKE_IMAP_PASSWORD=...
```

Then restart:

```bash
sudo systemctl restart sbg-tracker
```

For Microsoft 365 or Google Workspace, the mailbox may need IMAP enabled and an
app password or service account style credential.

**"npm ci" fails on the runner during deploy**

The instance might be running out of memory while installing
better-sqlite3 (it compiles native code). Either:
- Upgrade to t3.small temporarily for the install (~$0.02/hour), or
- Add a swap file: `sudo dd if=/dev/zero of=/swapfile bs=1M count=512 && sudo mkswap /swapfile && sudo swapon /swapfile`.
