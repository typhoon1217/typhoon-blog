---
title: Responding to Pack2theRoot on a Proxmox dev server
published: 2026-04-27
description: CVE-2026-41651 hit three of my six LXC containers. What I found, what broke during removal, and what changed afterwards.
tags:
  - infra
  - linux
  - proxmox
  - security
  - english
category: Infra
draft: false
---

Three of six LXC containers on my Proxmox setup turned out to be vulnerable to a CVE published five days ago. The interesting part: all six run Ubuntu 24.04, but only the .3 point-release ones were affected.

## What Pack2theRoot is

CVE-2026-41651 is a TOCTOU race condition in PackageKit discovered by Deutsche Telekom's Red Team. It's been sitting unfixed since November 2014 — twelve years. The bug lives in three spots in `src/pk-transaction.c`: a missing reauthorization check after InstallFiles() modifies transaction flags, backward state transitions that silently fail and corrupt flags, and cached flags read at dispatch time instead of authorization time.

The upshot: a local unprivileged user can install or remove arbitrary RPM packages as root, including running RPM scriptlets, with zero authentication. CVSS 8.8. PackageKit 1.0.2 through 1.3.4 are vulnerable. Fixed in 1.3.5.

Debian shipped patches (DSA-6226-1, DLA-4545-1) immediately. Ubuntu's on "Needs evaluation" — no USN yet as of April 27. Red Hat and Fedora are still pending.

## What I found in my environment

My Proxmox setup:

- **Host**: Debian 13 Trixie, kernel 6.17.2-1-pve. PackageKit not installed. Safe.
- **6 LXC containers**: all Ubuntu 24.04 base image. Three are .3 point-release, three are base .04.

Here's the vulnerable set:

| Container | OS             | PackageKit version |
|-----------|----------------|--------------------|
| A         | Ubuntu 24.04.3 | 1.2.8-2ubuntu1.5   |
| B         | Ubuntu 24.04.3 | 1.2.8-2ubuntu1.5   |
| C         | Ubuntu 24.04.3 | 1.2.8-2ubuntu1.5   |

The other three didn't have it at all.

The pattern: `software-properties-common` lists PackageKit as a Recommends dependency. Proxmox's 24.04.3 LXC template includes `software-properties-common`. The older 24.04 template apparently didn't. APT's default `Install-Recommends "true"` pulled PackageKit in as a side effect.

Pre-flight check showed the service was `static + inactive` on all three. Not running. But D-Bus activation means it can still be woken up. I found traces of it firing around April 26-27 with a 5-minute idle timeout — probably from unattended-upgrades or update-notifier checks.

## The removal — and a 11-package autoremove surprise

I ran a simulation first: `apt-get -s remove packagekit packagekit-tools software-properties-common`. Three packages. Clean.

Then I executed:

```bash
apt-get remove --purge packagekit packagekit-tools software-properties-common
apt-get autoremove --purge
```

The second command cascaded and killed 11 packages. Not three. Including **unattended-upgrades** — my daily security patch daemon.

That's the trap: `apt-get -s remove` shows only direct removals. It doesn't simulate what `autoremove` will yank. Both `software-properties-common` and other tools declare unattended-upgrades as a Recommends. When those go away, autoremove sees it as orphaned and purges it too.

Exposure window: roughly 2–3 minutes with no automatic security updates running.

I should have run both simulations separately: `-s remove` AND `-s autoremove`. I didn't.

## What I changed afterwards

**Reinstall unattended-upgrades without Recommends:**

```bash
apt-get install -y --no-install-recommends unattended-upgrades
apt-mark manual unattended-upgrades
```

The `--no-install-recommends` flag prevents PackageKit from sneaking back in. The `apt-mark manual` lock ensures future autoremove runs don't touch it.

Recreated the timer and service configs:

```bash
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

systemctl enable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service
```

Broader change: I'm adding a `/etc/apt/apt.conf.d/99-no-recommends` on all container templates so Recommends stay uninstalled by default. Servers don't need GNOME Calendar or D-Bus GUI daemons.

## Wrapping up

The real lesson isn't about Pack2theRoot specifically — it's that removing a service doesn't always remove just the service. Check what `autoremove` will do before you execute it. Use `--no-install-recommends` as a standard practice on servers. And mark critical auto-installed packages with `apt-mark manual` so they survive future cleanups. The best CVE is one that doesn't run in your environment at all.
