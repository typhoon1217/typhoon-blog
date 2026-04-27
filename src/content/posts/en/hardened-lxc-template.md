---
title: Baking hardening into a Proxmox LXC template
published: 2026-04-27
description: Build a hardened Ubuntu template in Proxmox once, clone it infinitely without repeating security cleanup.
tags:
  - infra
  - proxmox
  - linux
  - homelab
  - english
category: Infra
draft: false
---

Today's CVE had three of my six containers vulnerable. All were Ubuntu 24.04, all inherited the same weak apt config. Hardening each one individually is tedious. The fix: bake it into a template once, clone forever.

## Why I'm not doing this six more times

When `software-properties-common` pulls in `packagekit` as a Recommends dependency, and APT defaults to `Install-Recommends: true`, you end up with the same unnecessary, exploitable daemon on every container. Fixing it six ways is noise. Fixing it once at the template level is signal.

The pattern is simple: create a hardened base LXC, freeze it as a template, then clone from it. New containers inherit the hardening automatically. No manual repetition. No drift.

## Two kinds of "template" in Proxmox

Proxmox has two separate concepts that both use the word "template," which is confusing until you see it.

**OS template** is the seed — a `.tar.zst` file like `ubuntu-24.04-standard_24.04-2_amd64.tar.zst`. You download it via `pveam` and Proxmox uses it to initialize a new container's root filesystem. It's a one-time bootstrap.

**Container template** is what we're building. It's an actual LXC container that you've configured, hardened, and then frozen with `pct template <vmid>`. Once frozen, you can clone it infinitely. The original becomes read-only; clones get a copy or copy-on-write snapshot of its filesystem.

We want the second one.

## The build — including a DNS trap

Start by creating a base container from the OS template:

```bash
pct create 9000 local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
  --hostname ubuntu2404-hardened-tpl \
  --cores 1 --memory 1024 --swap 512 \
  --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=vmbr0,firewall=1,ip=dhcp,ip6=dhcp,type=veth \
  --features nesting=1 \
  --unprivileged 1 \
  --ostype ubuntu \
  --start 1
```

Now the trap: the container inherits the host's `/etc/resolv.conf`. If your host uses a mesh VPN or internal DNS that the container can't reach, DNS will fail immediately and you'll be stuck. Fix it by baking public DNS into the container config:

```bash
pct set 9000 --nameserver "1.1.1.1 8.8.8.8" --searchdomain local
```

This ensures the container can resolve names without depending on the host's network context. When you clone it later into a different environment, it just works.

Inside the container, start with the apt config:

```bash
pct exec 9000 -- bash -c "
echo 'APT::Install-Recommends \"false\";
APT::Install-Suggests   \"false\";' > /etc/apt/apt.conf.d/99-no-recommends
"
```

Then update and remove the vulnerable packages:

```bash
pct exec 9000 -- bash -c "
apt-get update && apt-get -y full-upgrade
apt-get -y remove --purge packagekit packagekit-tools software-properties-common
apt-get -y autoremove --purge
"
```

Install unattended-upgrades (now it won't pull packagekit back in):

```bash
pct exec 9000 -- bash -c "
apt-get install -y unattended-upgrades
apt-mark manual unattended-upgrades
"
```

Enable automatic patching. Edit `/etc/apt/apt.conf.d/20auto-upgrades` to enable the timers, then:

```bash
pct exec 9000 -- bash -c "
systemctl enable apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service
"
```

Now the invisible landmines: **machine-id** and **SSH host keys**. If you don't remove them, every clone will have the same values, which breaks systemd journal merging and gives you SSH host key mismatch warnings forever.

```bash
pct exec 9000 -- bash -c "
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id
rm -f /etc/ssh/ssh_host_*
"
```

Clean up logs and history:

```bash
pct exec 9000 -- bash -c "
apt-get clean
truncate -s 0 /var/log/wtmp /var/log/lastlog /var/log/btmp
for f in /var/log/*.log; do truncate -s 0 \"\$f\"; done
history -c && cat /dev/null > ~/.bash_history
"
```

Stop and freeze the container:

```bash
pct stop 9000
pct template 9000
```

The LVM volume renames from `vm-9000-disk-0` to `base-9000-disk-0`. That `base-` prefix marks it as the origin for clones.

Smoke test it:

```bash
pct clone 9000 9999 --hostname clone-test --full
pct start 9999
pct exec 9999 -- bash -c "
  cat /etc/machine-id          # newly generated
  dpkg -l | grep packagekit    # not installed
  dpkg -l | grep unattended-upgrades  # present
  cat /etc/apt/apt.conf.d/99-no-recommends
"
pct stop 9999 && pct destroy 9999
```

## The 4-layer DNA

This isn't just "remove packagekit." It's a system with four independent layers:

1. **`99-no-recommends`** blocks future contamination. Any future `apt install` inherits this config.
2. **Packagekit absence** eliminates the current attack surface.
3. **unattended-upgrades with manual flag** auto-patches future CVEs in other components and survives autoremove.
4. **Public DNS** ensures the container boots correctly in any environment without depending on the host's network setup.

Each layer solves a different problem. Layering them means you're defended against the current CVE, future ones in other packages, configuration drift, and environment mismatches.

## How to clone

For production use `--full`:

```bash
pct clone 9000 110 --hostname myapp --full
pct set 110 --memory 4096 --cores 2
pct start 110
```

The `--full` flag makes an independent thick copy. You lose the disk efficiency of linked clones, but you gain independence — the template can be deleted later without breaking anything.

---

One pattern, one template, infinite hardened containers. No repetition. No drift. That's the win.
