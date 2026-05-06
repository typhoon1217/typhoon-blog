---
title: Responding to Pack2theRoot — and the autoremove that took my patch daemon
published: 2026-04-27
description: CVE-2026-41651 hit three of my six LXC containers. What broke during removal — autoremove cascading into unattended-upgrades — and what I changed afterwards.
tags:
  - infra
  - linux
  - proxmox
  - security
  - english
category: Infra
draft: false
---

Three of six LXC containers on my Proxmox setup turned out to be vulnerable to a CVE published five days earlier. The interesting part: all six run Ubuntu 24.04, but only the *.3 point-release* ones were affected.

## Pack2theRoot — a 12-year-old PackageKit auth bypass

CVE-2026-41651, named Pack2theRoot, was published April 22. CVSS 8.8 HIGH. It's a TOCTOU race condition in PackageKit (discovered by Deutsche Telekom's Red Team) that's been sitting unfixed since November 2014 — twelve years. The bug lives in three spots in `src/pk-transaction.c`: a missing reauthorization check after `InstallFiles()` modifies transaction flags, backward state transitions that silently corrupt those flags, and cached flags read at dispatch time instead of authorization time.

The result: a local unprivileged user can install or remove arbitrary RPM packages as root, including running RPM scriptlets, with zero authentication. PackageKit 1.0.2 through 1.3.4 are vulnerable. Fixed in 1.3.5.

Distro response was uneven. Debian shipped patches (DSA-6226-1, DLA-4545-1) almost immediately. Ubuntu's Universe was on "Needs evaluation" — no USN as of April 27. Red Hat and Fedora pending.

## Why only 24.04.3 had PackageKit — APT Recommends plus the template

My Proxmox setup:

- **Host**: Debian 13 Trixie, kernel 6.17.2-1-pve. PackageKit not installed. Safe.
- **6 LXCs**: all Ubuntu 24.04 base image. Three on .3 point-release, three on plain .04.

The vulnerable set:

| Container | OS             | PackageKit version |
|-----------|----------------|--------------------|
| A         | Ubuntu 24.04.3 | 1.2.8-2ubuntu1.5   |
| B         | Ubuntu 24.04.3 | 1.2.8-2ubuntu1.5   |
| C         | Ubuntu 24.04.3 | 1.2.8-2ubuntu1.5   |

The other three didn't have it at all.

The cause was structural. `software-properties-common` lists `packagekit` as a Recommends dependency. APT's default `Install-Recommends "true"` pulls Recommends in automatically. Proxmox's 24.04.3 LXC template includes `software-properties-common`. The older 24.04 template apparently didn't. Three identical containers, all broken in the same way for the same reason.

Pre-flight check showed PackageKit was `static + inactive` on all three. Not running. But D-Bus activation means it can still be woken up — and traces showed it firing around April 26-27 with a 5-minute idle timeout, almost certainly from unattended-upgrades or update-notifier daily checks.

## The autoremove cascade also took unattended-upgrades

I ran a simulation first. `apt-get -s remove packagekit packagekit-tools software-properties-common` reported three packages. Clean.

```bash
apt-get remove --purge packagekit packagekit-tools software-properties-common && apt-get autoremove --purge
```

The second command cascaded and killed 11 packages — not three:

```
appstream
gir1.2-packagekitglib-1.0
libappstream5
libdw1t64
libglib2.0-bin
libgstreamer1.0-0
libpackagekit-glib2-18
libstemmer0d
libxmlb2
python3-software-properties
unattended-upgrades
```

**unattended-upgrades disappeared with the rest.** That's the daily security patch daemon, gone.

The trap was in the simulation step. `apt-get -s remove` shows only direct removals. It doesn't simulate what `autoremove` will yank afterwards. Both `software-properties-common` and several other packages declare `unattended-upgrades` as a Recommends. Once the parents go, autoremove sees it as orphaned and removes it.

I should have run *both* simulations: `-s remove` and then `-s autoremove`. Lesson taken.

Exposure window: roughly 2–3 minutes with no automatic security updates running.

## Recovery — `--no-install-recommends` and a manual hold

Reinstalling unattended-upgrades, this time without falling back into the Recommends trap:

```bash
apt-get install -y --no-install-recommends unattended-upgrades
```

PackageKit didn't come back along with it.

Then `apt-mark manual` so the next autoremove can't reach it:

```bash
apt-mark manual unattended-upgrades
```

Recreated the timer config:

```
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

```bash
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service
```

Automation restored.

## Lessons — turn off Recommends, simulate autoremove separately

Two things came out of this with broader application than Pack2theRoot itself.

**APT Recommends is a default that pulls GUI daemons onto servers.** The cleanest fix is `/etc/apt/apt.conf.d/99-no-recommends` set to `false`, applied at template build time so every clone inherits it. Failing that, `--no-install-recommends` on every install. The whole reason PackageKit was on these containers is exactly this default.

**autoremove needs a separate simulation.** `apt-get -s remove` and `apt-get -s autoremove` show different things. The first tells you which packages disappear; the second tells you which packages become orphans afterwards. Skip the second and you'll occasionally lose something you didn't mean to. Pin critical packages with `apt-mark manual` so they survive cascades regardless.

The deeper point is about attack-surface minimization. *static + inactive* services aren't really inactive when D-Bus can wake them. The only real immunity is package absence — if PackageKit isn't installed, no future PackageKit CVE applies. Code that isn't there can't break.
