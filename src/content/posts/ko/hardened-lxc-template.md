---
title: "Proxmox LXC 템플릿에 hardening 을 새겨두기"
published: 2026-04-27
description: "CVE 대응 후 재발 방지용 hardened base template 한 번 만들어두면 모든 자손 컨테이너가 자동 상속하는 패턴"
tags:
  - infra
  - proxmox
  - linux
  - homelab
  - korean
category: Infra
draft: false
---

같은 hardening 작업을 컨테이너 6개에 반복하다 보면 어디에 박아두고 싶어진다. Proxmox 의 `pct template` 이 그 자리다.

## 왜 매번 같은 일을 반복하나

지난주 CVE-2026-41651 대응을 끝낸 후 깨달았다. 운영 중인 LXC 6개 중 3개가 같은 취약점에 노출되어 있었다. 원인은 간단했다. Ubuntu 24.04 의 `software-properties-common` 패키지가 `PackageKit` 을 Recommends 로 끌어오고, APT 기본 설정이 Recommends 를 자동 설치하기 때문이었다. 모두 같은 이유로 같은 패키지를 깔고 있었고, 따라서 모두 같은 방식으로 정리해야 했다.

그때 생각했다. 매번 새 LXC 를 만들 때마다 이 정리 작업을 반복해야 하나? 한 번 hardening 한 base template 을 만들어두면, 그것에서 clone 한 모든 컨테이너는 자동으로 safe 상태에서 출발하지 않을까.

## Proxmox 에서 "template" 의 두 종류

혼동하기 쉬운데, template 은 두 가지다.

**OS template** 은 `pveam` 으로 받는 `.tar.zst` 파일이다. 컨테이너의 root filesystem 시드 역할. `/var/lib/vz/template/cache/ubuntu-24.04-standard_24.04-2_amd64.tar.zst` 이런 식.

**Container template** 은 `pct template <vmid>` 로 변환된 정지된 LXC 컨테이너다. `pct clone` 으로 복제 가능하고, 저장 백엔드는 LVM 의 읽기 전용 snapshot (base- prefix) 으로 관리된다.

우리가 만드는 건 ②다. ① 위에 hardening 레이어를 한 번 더 얹은 형태.

## 빌드 — 함정 포함

### 1단계: Base LXC 생성

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

컨테이너가 시작되는데 여기서 첫 함정을 만난다.

### 함정 1: DNS 상속 문제

새 LXC 의 `/etc/resolv.conf` 가 호스트의 `/etc/resolv.conf` 를 상속한다. 호스트가 NetBird mesh DNS (`100.73.6.47`) 를 사용 중이라면, 새 컨테이너는 mesh 멤버가 아니라 도달 불가다. 결과는 DNS fail.

해결책:

```bash
pct set 9000 --nameserver "1.1.1.1 8.8.8.8" --searchdomain local
```

이렇게 자급자족 DNS 를 박아넣으면 어느 환경에서 boot 되든 작동한다.

### 2단계: Hardening

컨테이너에 접속해서 진행한다.

먼저 APT 설정:

```bash
pct exec 9000 -- bash -c 'cat > /etc/apt/apt.conf.d/99-no-recommends << EOF
APT::Install-Recommends "false";
APT::Install-Suggests   "false";
EOF'
```

이 파일은 나중에 모든 clone 이 상속받는다. 미래의 어떤 패키지도 Recommends 를 끌어오지 않는다.

업그레이드 및 정리:

```bash
pct exec 9000 -- bash -c "
  apt-get update && apt-get -y full-upgrade
  apt-get -y remove --purge packagekit packagekit-tools software-properties-common
  apt-get -y autoremove --purge
  apt-get install -y unattended-upgrades
  apt-mark manual unattended-upgrades
"
```

`apt-mark manual` 은 중요하다. 나중에 다른 CVE 패치가 필요할 때 autoremove 에서 보호된다.

자동 업데이트 활성화:

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

로그 청소:

```bash
pct exec 9000 -- bash -c "
  apt-get clean
  truncate -s 0 /var/log/wtmp /var/log/lastlog /var/log/btmp
  find /var/log -name '*.log' -exec truncate -s 0 {} \;
  > /root/.bash_history
"
```

### 함정 2: Machine ID 와 SSH host key

이제 가장 중요한 부분. 안 하면 모든 clone 이 같은 ID 와 key 를 가진다.

```bash
pct exec 9000 -- bash -c "
  truncate -s 0 /etc/machine-id
  rm -f /var/lib/dbus/machine-id
  ln -s /etc/machine-id /var/lib/dbus/machine-id
  rm -f /etc/ssh/ssh_host_*
"
```

`machine-id` 를 비우면 부팅 시 새로 생성된다. SSH host key 를 제거하면 sshd 나 systemd-tmpfiles 가 부팅 시 자동 재생성한다. 이게 없으면:
- 모든 clone 이 같은 machine-id → systemd journal merge 충돌
- 모든 clone 이 같은 SSH key → MITM 경고 폭탄

### 3단계: 템플릿 변환

```bash
pct stop 9000
pct template 9000
```

이 명령어가 실행되면 LVM 볼륨이 `vm-9000-disk-0` 에서 `base-9000-disk-0` 으로 rename 된다. `base-` prefix 는 템플릿의 읽기 전용 origin 을 의미한다.

### 검증

```bash
pct clone 9000 9999 --hostname clone-test --full
pct start 9999
pct exec 9999 -- bash -c "
  cat /etc/machine-id        # 새로 생성됨 (다른 ID)
  dpkg -l | grep packagekit  # not installed
  dpkg -l | grep unattended  # 2.9.1 ✓
  cat /etc/apt/apt.conf.d/99-no-recommends  # 설정 살아있음
"
pct stop 9999 && pct destroy 9999
```

## 4중 방어 DNA

1. **99-no-recommends** — 미래 자동 오염 차단. 앞으로 어떤 패키지를 install 해도 Recommends 가 끌려오지 않는다.
2. **packagekit 부재** — 현재의 attack surface 제거.
3. **unattended-upgrades + manual flag** — 다른 CVE 자동 패치 + autoremove 보호.
4. **public DNS** — 어떤 환경에서든 즉시 인터넷 가능.

이 4가지가 template DNA 에 새겨지면, 그것의 모든 자손 컨테이너는 출발 지점부터 같은 방어 자세를 유지한다.

## Clone 사용법

```bash
# Linked clone (빠름, 디스크 절약, 템플릿 의존)
pct clone 9000 <new_vmid> --hostname <name>

# Full clone (느림, 독립적, 운영 환경 권장)
pct clone 9000 <new_vmid> --hostname <name> --full
```

필요 시 자원 조정:

```bash
pct set <new_vmid> --memory 4096 --cores 2
pct start <new_vmid>
```

## 결론

hardening 을 한 번 template 에 박아두면, 후속 컨테이너들은 처음부터 safe 상태에서 출발한다. 동일한 보안 정책이 template 의 DNA 가 되어 모든 clone 에 자동 상속되므로, CVE 대응 후 또 다른 환경에서 같은 취약점에 노출될 확률은 현저히 낮아진다. Proxmox 환경에서 운영 중인 여러 LXC 가 있다면, 이 작업은 한 번의 투자로 반복 작업을 거의 영구적으로 줄인다.
