---
title: Baking hardening into a Proxmox LXC template
published: 2026-04-27
description: Build a hardened Ubuntu template in Proxmox once, clone it forever. The same security policy lives in the template's DNA and every child inherits it automatically.
tags:
  - infra
  - proxmox
  - linux
  - homelab
  - english
category: Infra
draft: false
---

Three of my six containers were vulnerable to last week's CVE. All six were Ubuntu 24.04 with the same weak apt config. Hardening each one individually is noise. The fix: bake the hardening into a template once, clone forever.

## Why I'm not doing this six more times

When `software-properties-common` pulls in `packagekit` as a Recommends dependency, and APT defaults to `Install-Recommends: true`, you end up with the same unnecessary, exploitable daemon on every container. Fixing it six ways is repetition. Fixing it once at the template level is design.

The pattern is simple — create a hardened base LXC, freeze it as a template, then clone from it. New containers inherit the hardening automatically. No manual repetition. No drift.

## Two kinds of "template" in Proxmox — easy to confuse

Proxmox uses the word "template" for two separate concepts.

**OS template** is the seed — a `.tar.zst` file like `ubuntu-24.04-standard_24.04-2_amd64.tar.zst`. You download it via `pveam` and Proxmox uses it to initialize a new container's root filesystem. One-time bootstrap.

**Container template** is what we're building. It's an actual LXC container that you've configured, hardened, and then frozen with `pct template <vmid>`. Once frozen, you can clone it infinitely. The original becomes read-only; clones get a copy or copy-on-write snapshot of its filesystem.

We want the second one. The first becomes an input to it.

## Step 1: create the base LXC — including a DNS trap

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

Here's the trap: the container inherits the host's `/etc/resolv.conf`. If your host uses a mesh VPN or internal DNS that the container can't reach, DNS will fail immediately and you'll be stuck.

Bake public DNS into the container config so it doesn't depend on the host's network context:

```bash
pct set 9000 --nameserver "1.1.1.1 8.8.8.8" --searchdomain local
```

Now when you clone this into any environment, name resolution just works.

## Step 2: harden — bake four defensive layers in

Start with the apt config. Block Recommends globally so no future install can pull GUI daemons in.

```bash
pct exec 9000 -- bash -c "
echo 'APT::Install-Recommends \"false\";
APT::Install-Suggests   \"false\";' > /etc/apt/apt.conf.d/99-no-recommends
"
```

This file gets inherited by every clone. Future-proofing.

Update, remove the vulnerable packages, install unattended-upgrades.

```bash
pct exec 9000 -- bash -c "
apt-get update && apt-get -y full-upgrade
apt-get -y remove --purge packagekit packagekit-tools software-properties-common
apt-get -y autoremove --purge
apt-get install -y unattended-upgrades
apt-mark manual unattended-upgrades
"
```

`apt-mark manual` matters. It pins unattended-upgrades against future autoremove cascades — exactly the kind of cascade that bit me when I removed PackageKit on already-running containers.

Enable the auto-patch timers:

```bash
pct exec 9000 -- bash -c "
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists \"1\";
APT::Periodic::Download-Upgradeable-Packages \"1\";
APT::Periodic::AutocleanInterval \"7\";
APT::Periodic::Unattended-Upgrade \"1\";
EOF
systemctl enable apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service
"
```

Strip logs and history so the template doesn't carry environment-specific traces forward.

```bash
pct exec 9000 -- bash -c "
apt-get clean
truncate -s 0 /var/log/wtmp /var/log/lastlog /var/log/btmp
for f in /var/log/*.log; do truncate -s 0 \"\$f\"; done
history -c && cat /dev/null > ~/.bash_history
"
```

## The pre-freeze gotcha: zero out machine-id and SSH host keys

If you skip this, every clone inherits identical machine-id and SSH host keys. Two things go wrong simultaneously.

- Same machine-id across clones breaks systemd journal merging
- Same SSH host keys give every client a MITM warning forever

```bash
pct exec 9000 -- bash -c "
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id
rm -f /etc/ssh/ssh_host_*
"
```

Once the file is empty, systemd regenerates `machine-id` on first boot. sshd or systemd-tmpfiles regenerates the host keys.

## Step 3: convert to template, verify

```bash
pct stop 9000
pct template 9000
```

The LVM volume renames from `vm-9000-disk-0` to `base-9000-disk-0`. The `base-` prefix marks it as the read-only origin for clones.

Smoke test before trusting it:

```bash
pct clone 9000 9999 --hostname clone-test --full
pct start 9999
pct exec 9999 -- bash -c "
  cat /etc/machine-id          # newly generated, different ID
  dpkg -l | grep packagekit    # not installed
  dpkg -l | grep unattended-upgrades  # present
  cat /etc/apt/apt.conf.d/99-no-recommends
"
pct stop 9999 && pct destroy 9999
```

## The four-layer DNA — what each layer defends against

This isn't just "remove packagekit." It's four independent layers that together cover four classes of failure.

1. **`99-no-recommends`** — blocks future contamination. Any later `apt install` inherits this config.
2. **PackageKit absence** — eliminates the current attack surface. No code, no CVE.
3. **unattended-upgrades + manual flag** — auto-patches future CVEs in other components, survives autoremove cascades.
4. **Public DNS** — guarantees the container boots correctly in any environment, no host-network dependency.

Each layer addresses a different failure mode. Stacking them defends against the current CVE, future ones in other packages, configuration drift, and environment mismatches all at once.

## How to clone

For production use `--full`:

```bash
pct clone 9000 110 --hostname myapp --full
pct set 110 --memory 4096 --cores 2
pct start 110
```

`--full` makes an independent thick copy. You lose the disk efficiency of linked clones but gain independence — the template can be deleted later without breaking anything that came from it.

## The win — repetition replaced by inheritance

Hardening containers by hand always misses one. The next CVE in this category will hit whichever container the engineer forgot to update. Bake the policy into the template instead and that gap closes structurally — every clone starts from the safe state, every clone inherits future template changes if you rebuild. One investment, permanent return. The next CVE in this shape doesn't find a vulnerable container at all.
