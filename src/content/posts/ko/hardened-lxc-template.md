---
title: Proxmox LXC 템플릿에 hardening을 새겨두기
published: 2026-04-27
description: CVE 대응 후 재발 방지용 hardened base template을 한 번 만들어두면 모든 자손 컨테이너가 자동 상속하는 패턴.
tags:
  - infra
  - proxmox
  - linux
  - homelab
  - korean
category: Infra
draft: false
---

같은 hardening을 LXC 6개에 반복하다 보면 어디에 박아두고 싶어진다. Proxmox의 `pct template`이 그 자리다.

## 같은 hardening을 6번 반복하지 말 것

지난주 CVE-2026-41651 대응을 끝낸 후 깨달았다. 운영 중인 LXC 6개 중 3개가 같은 취약점에 노출되어 있었다. 원인은 단순했다 — Ubuntu 24.04의 `software-properties-common` 패키지가 `packagekit`을 Recommends로 끌어오고, APT 기본 설정이 Recommends를 자동 설치한다. 셋이 같은 이유로 같은 패키지를 깔고 있었으니, 정리도 같은 방식으로 세 번 반복해야 했다.

매번 새 LXC를 만들 때마다 이 정리를 반복할 이유가 없다. 한 번 hardening한 base template을 만들어두면, 거기서 clone한 모든 컨테이너는 *처음부터 safe 상태*에서 출발한다.

## Proxmox에서 "template"의 두 가지 — 혼동하기 쉬움

template은 두 가지다.

**OS template**은 `pveam`으로 받는 `.tar.zst` 파일. 컨테이너 root filesystem 시드 역할이다. 예: `/var/lib/vz/template/cache/ubuntu-24.04-standard_24.04-2_amd64.tar.zst`.

**Container template**은 `pct template <vmid>`로 변환된 정지된 LXC 컨테이너. `pct clone`으로 복제 가능하고, 저장 백엔드는 LVM의 읽기 전용 snapshot(`base-` prefix)으로 관리된다.

만들 건 후자다. 전자 위에 hardening 레이어를 한 번 더 얹은 형태.

## 1단계: Base LXC 생성 — DNS 상속 함정 포함

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

여기서 첫 함정이 나온다. 새 LXC의 `/etc/resolv.conf`는 호스트의 `/etc/resolv.conf`를 상속한다. 호스트가 mesh VPN의 사설 DNS를 쓰고 있다면, 새 컨테이너는 mesh 멤버가 아니므로 도달 불가. 결과는 DNS fail.

해결은 간단하다 — 컨테이너 자체에 자급자족 DNS를 박아넣으면 된다.

```bash
pct set 9000 --nameserver "1.1.1.1 8.8.8.8" --searchdomain local
```

이렇게 두면 어느 환경에 clone되든 작동한다.

## 2단계: Hardening — 4가지 기본 정책을 한 번에 박는다

먼저 APT 기본 정책을 바꾼다. Recommends 자동 설치 차단.

```bash
pct exec 9000 -- bash -c 'cat > /etc/apt/apt.conf.d/99-no-recommends << EOF
APT::Install-Recommends "false";
APT::Install-Suggests   "false";
EOF'
```

이 파일은 모든 clone이 상속받는다. 미래의 어떤 패키지도 Recommends를 끌어오지 않는다.

다음, 업그레이드와 정리. PackageKit과 software-properties-common을 한꺼번에 제거.

```bash
pct exec 9000 -- bash -c "
  apt-get update && apt-get -y full-upgrade
  apt-get -y remove --purge packagekit packagekit-tools software-properties-common
  apt-get -y autoremove --purge
  apt-get install -y unattended-upgrades
  apt-mark manual unattended-upgrades
"
```

`apt-mark manual`이 중요하다. 나중에 다른 CVE 패치가 필요할 때 autoremove cascade에서 unattended-upgrades를 보호한다.

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

마지막으로 로그·히스토리 청소. 템플릿이 환경별 잔재를 들고 가지 않도록.

```bash
pct exec 9000 -- bash -c "
  apt-get clean
  truncate -s 0 /var/log/wtmp /var/log/lastlog /var/log/btmp
  find /var/log -name '*.log' -exec truncate -s 0 {} \;
  > /root/.bash_history
"
```

## 함정 — machine-id와 SSH host key는 반드시 비울 것

이 단계가 빠지면 모든 clone이 같은 ID와 같은 SSH key를 가진다.

```bash
pct exec 9000 -- bash -c "
  truncate -s 0 /etc/machine-id
  rm -f /var/lib/dbus/machine-id
  ln -s /etc/machine-id /var/lib/dbus/machine-id
  rm -f /etc/ssh/ssh_host_*
"
```

`machine-id`를 비우면 부팅 시 새로 생성된다. SSH host key는 sshd나 systemd-tmpfiles가 부팅 시 자동 재생성한다. 안 비우면 두 가지가 동시에 터진다.

- 모든 clone이 같은 machine-id → systemd journal merge 충돌
- 모든 clone이 같은 SSH key → 클라이언트마다 MITM 경고 폭탄

## 3단계: 템플릿 변환 + 검증

```bash
pct stop 9000
pct template 9000
```

이 명령으로 LVM 볼륨이 `vm-9000-disk-0`에서 `base-9000-disk-0`로 rename된다. `base-` prefix가 템플릿의 읽기 전용 origin을 의미한다.

스모크 테스트:

```bash
pct clone 9000 9999 --hostname clone-test --full
pct start 9999
pct exec 9999 -- bash -c "
  cat /etc/machine-id        # 새로 생성된 ID
  dpkg -l | grep packagekit  # not installed
  dpkg -l | grep unattended  # 2.9.1 ✓
  cat /etc/apt/apt.conf.d/99-no-recommends
"
pct stop 9999 && pct destroy 9999
```

## 4중 방어 — 각 layer가 막는 위협

이 템플릿은 단순히 "PackageKit 제거"가 아니다. 네 가지 독립 layer로 구성된 시스템이다.

1. **`99-no-recommends`** — 미래의 자동 오염 차단. 어떤 패키지를 install해도 Recommends가 따라오지 않는다.
2. **packagekit 부재** — 현재 attack surface 제거.
3. **unattended-upgrades + manual flag** — 다른 CVE 자동 패치 + autoremove 보호.
4. **public DNS** — 어느 환경에서 boot되든 즉시 인터넷 가능.

각 layer가 다른 문제를 해결한다. 합쳐 두면 현재 CVE, 미래 다른 패키지의 CVE, configuration drift, 환경 불일치까지 한꺼번에 방어된다.

## Clone 사용법

운영용은 `--full`을 권장한다. 디스크 효율은 떨어지지만 독립적이라 템플릿 삭제에도 영향이 없다.

```bash
# Full clone (운영 권장)
pct clone 9000 110 --hostname myapp --full

# Linked clone (빠름, 디스크 절약, 템플릿 의존)
pct clone 9000 111 --hostname dev-test
```

자원 조정은 clone 후 `pct set`으로:

```bash
pct set 110 --memory 4096 --cores 2
pct start 110
```

## 결론 — 반복을 상속으로 바꾸기

운영 환경에서 hardening을 매번 손으로 적용하면 결국 어디선가 한 컨테이너가 누락된다. 한 번 템플릿에 박아두면 누락이 일어나지 않는다 — 같은 정책이 모든 자손에게 자동 상속되기 때문이다. 한 번의 투자로 미래의 반복 작업이 사라지고, 다음에 같은 형태의 CVE가 떠도 *이미 막혀있는 컨테이너만 남는다*.
