---
title: Migrating Proxmox 8 to 9 and breaking docker along the way
published: 2026-05-04
description: A walkthrough of upgrading PVE 8.4 to 9.1.9, the docker/runc regression that hit unprivileged LXCs in between, and clearing CVE-2026-35535 in sudo.
tags:
  - linux
  - security
  - proxmox
  - docker
  - lxc
  - infra
  - homelab
  - english
category: Infrastructure
draft: false
---

My homelab Proxmox host had not been patched in close to a year. Kernel 6.8.12-9-pve, sudo CVE-2026-35535 still open. The plan was to do the audit and the PVE 9 migration in a single session. Halfway through, docker broke on every container.

## Five issues from scan-all-cves

A 12-CVE gating script I maintain flagged five items as [VULN] or [WARN].

- CVE-2026-31431 — Copy Fail, AF_ALG kernel LPE
- CVE-2026-23113 — io_uring race
- CVE-2026-32202 — NTLM coercion via CIFS
- CVE-2026-35414 — OpenSSH SplitSSHell
- CVE-2026-35535 — sudo privilege drop

Blocking AF_ALG took five minutes. One file in modprobe.d to stop autoload, then unload anything already loaded. No reboot needed.

```bash
# /etc/modprobe.d/disable-algif-cve-2026-31431.conf
install af_alg /bin/false
install algif_aead /bin/false
install algif_skcipher /bin/false
install algif_hash /bin/false
install algif_rng /bin/false
```

Routine work. The trouble started after.

## Patching the LXCs killed all docker

I ran `apt dist-upgrade -y` across 11 LXCs. docker-ce jumped 28.1.1 → 28.5.2, and containerd.io went from 1.7.x → 2.2.3 along with it. Compose came back up, then:

```
Error response from daemon: failed to create task for container:
  failed to create shim task: OCI runtime create failed:
  runc create failed: unable to start container process:
  error during container init:
  open sysctl net.ipv4.ip_unprivileged_port_start file:
  reopen fd 8: permission denied
```

vaultwarden, nextcloud, keycloak, every portainer instance. All 11 LXCs failed to start their containers.

The cause was not docker. **runc went from 1.1.x to 1.3.3, which follows OCI spec 1.2.1**, and that version tries to write `ip_unprivileged_port_start` sysctl from inside the user namespace. PVE 8.4 mounts `/proc/sys` read-only inside unprivileged LXCs. Write fails, container init fails.

I assumed downgrading docker-ce would fix it. It did not. Even on docker 28, if containerd.io is the 2.x branch, the bundled runc is still 1.3. Both have to come down together and stay pinned.

```
docker-ce             5:28.1.1-1~ubuntu.24.04~noble
docker-ce-cli         5:28.1.1-1~ubuntu.24.04~noble
docker-ce-rootless-extras  5:28.1.1-1~ubuntu.24.04~noble
containerd.io         1.7.18-1   # bundles runc 1.1.13
```

`apt-mark hold` on six packages, then everything came back. From the first apt run to recovery, 90 minutes lost.

## PVE 9 made the regression go away

At this point I asked whether PVE 9 itself was the right move. Turned out it was forced: CVE-2026-35535 is unfixed in Debian 12 stable. The sid sudo (1.9.17p2) wants `libc6 ≥ 2.42`, and bookworm ships 2.36. Forcing libc upgrade is system suicide. The fix lives in Debian 13 trixie, which is what PVE 9 is built on.

`pve8to9` returned one FAIL: a stale ceph cluster too old to upgrade. But looking at it — OSD 0, pools 0, objects 0. An empty cluster left running with just mon and mgr. `pveceph mon destroy` + `pveceph purge` cleared it; checks were green after.

`vzdump` ran on all 12 guests (11 LXC + 1 VM). zstd compressed the lot to 17 GB. Then dist-upgrade: 800+ packages, reboot, host comes up on kernel 7.0.0-3-pve.

The interesting part: **on PVE 9 I lifted the docker hold and everything just works**. Same unprivileged LXCs, but PVE 9's LXC userns now permits the sysctl write. docker 29.4.2 + containerd.io 2.2.3 + runc 1.3.3 all run. The regression evaporated.

After:

- sudo: 1.9.13p3 (vuln) → **1.9.16p2-3+deb13u1** (CVE-2026-35535 fixed)
- Host trivy CRIT+HIGH: 142 → **60** (-58%)
- scan-all-cves: 9 of 12 [OK]

## detect.sh produces false [VULN]s

Two of the remaining [VULN] entries are glibc CVEs that the Debian changelog says are already fixed.

```
$ zcat /usr/share/doc/libc6/changelog.Debian.gz | grep -i CVE-2026-0861
  (CVE-2026-0861).  Closes: #1125678.
```

detect.sh only compares distro cutoff versions, so silent Debian backports slip past. Same story for CVE-2026-35535. Debian classed it "minor issue, no DSA" because Debian's sudo is built with `--disable-root-mailer`, which strips the vulnerable code path out of the binary entirely. detect says [VULN], real exploit risk is zero. You cannot see this without checking the binary's compile flags.

Don't accept the scan output as final. Pull the changelog and check the build.

## CVE patching is only one side

After the upgrade I ran Lynis, ssh-audit, and Docker Bench for Security against the host and the LXCs.

- Lynis hardening index: **64/100** (60–80 = improve range)
- ssh-audit: 6 [fail] entries — NIST P-256/384/521 curves and SHA-1 MACs
- Docker Bench score: **11/105**

CVEs basically all green, but no fail2ban, no GRUB password, no auditd watching docker, sshd advertising weak algorithms. CVE-only thinking misses half the picture.

fail2ban install + a basic jail: 5 minutes. Pinning sshd to strong KEX/Cipher/MAC: 5 minutes. Password policy in `/etc/login.defs`: one sed. auditd watches on docker dirs: a few rules. None of it is exciting, but cumulatively it reduces more risk than chasing the next single CVE.

## Wrapping up

In one session: PVE 8.4 → PVE 9.1.9, full host + 11 LXC patch, docker regression diagnosed and recovered, hardening pass on top. Four takeaways.

- **Don't sit on major upgrades.** Some CVEs only resolve on the new base — sudo 35535 needs libc 2.42, full stop.
- **Regressions hide in adjacent packages.** I thought this was a docker problem. It was containerd.io's runc bundle. Always suspect the side effects of dist-upgrade.
- **Scan tools default to conservative.** A [VULN] flag is a hypothesis, not a verdict. Confirm with changelog and build flags before acting.
- **Patching alone produces a hardened-on-paper system.** Run Lynis once. It takes five minutes and surfaces the things CVE scanners can't.
