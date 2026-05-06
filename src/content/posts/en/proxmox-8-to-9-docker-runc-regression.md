---
title: When PVE 8.4 docker broke — runc was the real culprit
published: 2026-05-04
description: A single apt dist-upgrade across 11 unprivileged LXCs killed every docker container. The cause wasn't docker — it was runc 1.3's OCI spec change colliding with PVE 8.4's read-only /proc/sys.
tags:
  - linux
  - proxmox
  - docker
  - lxc
  - runc
  - infra
  - homelab
  - english
category: Infrastructure
draft: false
featured: true
---

One dist-upgrade across 11 LXCs killed vaultwarden, nextcloud, keycloak — every docker container in the homelab. I assumed docker was at fault. The actual culprit was runc, dragged along as a transitive bump.

## All 11 LXCs failed at once after the patch

The Proxmox 8.4 host had 11 unprivileged LXCs running docker workloads, all overdue for security patches. I ran `apt dist-upgrade -y` inside each one — about 800 packages updated per container, including docker-ce 28.1.1 → 28.5.2 and containerd.io 1.7 → 2.2.3 as major jumps.

After the patch every container reported the same error:

```
Error response from daemon: failed to create task for container:
  failed to create shim task: OCI runtime create failed:
  runc create failed: unable to start container process:
  error during container init:
  open sysctl net.ipv4.ip_unprivileged_port_start file:
  reopen fd 8: permission denied
```

vaultwarden, nextcloud, keycloak, every portainer instance — all dead with the same message.

## The cause was runc 1.3's sysctl reset, not docker

The first thirty minutes I stared at docker daemon logs. Got nowhere. Re-reading the OCI message itself, the relevant line was "sysctl ... permission denied" — failure happens *below* docker, in the runtime layer.

Tracking the dependency closure, containerd.io 2.x bundles runc 1.3. The 1.1 → 1.3 jump implements OCI runtime spec 1.2.1, which includes a behavior change: at container init, runc resets `net.ipv4.ip_unprivileged_port_start` to the default value.

On a normal Linux host this is harmless. But PVE 8.4's unprivileged LXC mounts `/proc/sys` read-only as a security policy. New runc tries to write → denied → init fails → the entire container dies.

In short: docker is fine. The runc bumped along with it cannot perform its new init step inside an unprivileged LXC with read-only sysfs.

## Emergency fix — six packages downgraded and held

I tried downgrading just docker-ce to 28.1 first. Same error. docker 28 still requires containerd.io 2.x, which bundles runc 1.3. Both have to come down together.

```
docker-ce                  5:28.1.1-1~ubuntu.24.04~noble
docker-ce-cli              5:28.1.1-1~ubuntu.24.04~noble
docker-ce-rootless-extras  5:28.1.1-1~ubuntu.24.04~noble
containerd.io              1.7.18-1     # bundles runc 1.1.13
docker-buildx-plugin       0.14.x
docker-compose-plugin      2.27.x
```

Six packages held with `apt-mark hold`. Containers came back up. Total time from patch to recovery: one hour thirty.

## PVE 9 makes the same combination work

Holding packages is a tax that surfaces every patch cycle. The real fix had to live on the host side. PVE 9.1.9 had been stable for a month at this point.

`pve8to9` flagged one FAIL — an aging ceph cluster. Looking at it: 0 OSDs, 0 pools, 0 objects. Someone had set up mon/mgr ages ago and forgotten about it. `pveceph mon destroy` + `pveceph purge` cleared it. 0 FAIL after that.

`vzdump` backed up all 12 guests (11 LXC + 1 VM, 17GB zstd), then dist-upgrade. 800+ packages, host reboot, kernel 7.0.0-3-pve up.

Here's where it got interesting. **On PVE 9 the docker holds can be released.** Same unprivileged LXCs, but PVE 9's LXC 4.x userns now permits sysctl writes that PVE 8.4 forbade. docker 29.4.2 + containerd.io 2.2.3 + runc 1.3.3 — all 11 containers up, no holds, no errors. The regression resolved itself with the host major upgrade.

## Lesson — suspect the bundle, not the headline package

What looked like a docker regression was actually a three-way mismatch: a host policy (PVE 8.4 read-only sysfs), a spec evolution (OCI 1.2.1), and a transitive dependency (runc inside containerd.io). None of the three has a bug. They just don't combine.

This kind of regression tends to come from two sources:

- **Major bumps inside transitive dependencies.** `apt dist-upgrade` pulls the dependency tree forward, not just the packages you installed by name. Watching docker tells you nothing about what containerd.io and runc are doing under it.
- **Container runtime + host isolation policy.** OCI spec changes that work fine on a regular Linux host can need new privileges in isolated environments. Unprivileged LXC, gVisor, Kata — anywhere the kernel-side namespace policy diverges from a stock host.

The biggest takeaway is that postponing major upgrades isn't the safe choice it looks like. A year of postponed upgrades comes back as a year of regressions in one afternoon. Patching frequently makes regressions easier to localize because there are fewer simultaneous moving parts. The 90 minutes here was tuition for that lesson.
