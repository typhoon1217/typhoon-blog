---
title: Proxmox에서 LXC로 홈서버 서비스 분리하기
published: 2026-04-14
description: Proxmox 홈서버에서 VM 대신 LXC 컨테이너로 서비스를 격리하는 방법과 그 이유.
tags:
  - infra
  - linux
  - homelab
  - proxmox
  - korean
category: Infrastructure
draft: false
---

서비스를 하나씩 VM으로 돌리다 보면 메모리가 금방 바닥난다. 서비스 5개에 VM 5개, RAM은 32GB인데 여유가 없다. LXC로 바꾸고 나서 같은 서버에 서비스를 두 배 이상 올렸다.

## VM 대신 LXC를 쓰는 이유

VM은 게스트 OS 전체를 띄운다. 커널도 따로, 메모리도 따로. Ubuntu VM 하나에 최소 512MB는 잡아야 한다.

LXC는 호스트 커널을 공유한다. 컨테이너 안에서는 독립된 환경처럼 보이지만 실제로는 호스트의 커널 위에서 돌아간다. RAM 사용량이 훨씬 적다. Nginx만 돌리는 컨테이너라면 50-100MB면 충분하다.

격리 수준은 VM보다 낮다. 커널을 공유하기 때문에 커널 취약점은 컨테이너를 통해 호스트에 영향을 줄 수 있다. 홈서버에서 내부 서비스만 돌린다면 이 정도 트레이드오프는 감수할 수 있다.

## Proxmox에서 LXC 만들기

먼저 컨테이너 템플릿을 받는다. Proxmox 웹 UI에서 **Datacenter → node → local → CT Templates**에서 다운로드하거나, 터미널에서:

```bash
pveam update
pveam available | grep ubuntu
pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst
```

컨테이너 생성은 웹 UI 우상단 **Create CT** 버튼. 설정할 것들:

- **CT ID**: 100번대부터. VM ID와 겹치지 않게.
- **Hostname**: 서비스 이름으로. `nginx`, `gitea`, `grafana` 식으로.
- **Template**: 방금 받은 걸로.
- **Disk**: 서비스에 따라 8-20GB면 대부분 충분하다.
- **CPU / Memory**: 처음엔 넉넉하게 주고 모니터링 보면서 줄인다.
- **Network**: `vmbr0` 브릿지에 연결하고 고정 IP 할당.

## 네트워크 설정

컨테이너마다 고정 IP를 주는 게 관리하기 편하다. Ubuntu 컨테이너라면 Netplan으로:

```yaml
# /etc/netplan/10-lxc.yaml
network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - 192.168.1.110/24
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
```

서비스별로 IP 대역을 정해두면 나중에 보기 편하다:
- `192.168.1.100-109` — 인프라 (Nginx, DNS)
- `192.168.1.110-119` — 모니터링 (Grafana, Prometheus)
- `192.168.1.120-129` — 앱 서비스

## 호스트 디렉토리 마운트

데이터는 컨테이너 밖에 두는 게 낫다. 컨테이너를 날려도 데이터는 남는다.

웹 UI → 컨테이너 → Resources → Add → Mount Point로 bind mount 추가하거나, `/etc/pve/lxc/[CTID].conf`에 직접:

```
mp0: /data/gitea,mp=/opt/gitea/data
```

컨테이너 재시작하면 적용된다. 호스트의 `/data/gitea`가 컨테이너 안 `/opt/gitea/data`로 연결된다.

## 실제 구성

현재 홈서버에서 돌리는 구성:

| CT ID | 서비스 | RAM | 역할 |
|-------|--------|-----|------|
| 100 | nginx | 128MB | 리버스 프록시 |
| 101 | postgres | 512MB | 공용 DB |
| 110 | grafana | 256MB | 모니터링 대시보드 |
| 111 | prometheus | 256MB | 메트릭 수집 |
| 120 | gitea | 256MB | Git 서버 |
| 121 | nextcloud | 512MB | 파일 서버 |

전부 합쳐도 RAM 2GB 언저리다. VM으로 했다면 최소 8-10GB는 썼을 거다.

서비스가 죽거나 업데이트할 때 해당 컨테이너만 재시작하면 된다. 다른 서비스에 영향이 없다. 이게 분리의 핵심이다.

---

LXC는 홈서버에서 서비스를 운영하는 가장 실용적인 방법이다. Docker도 좋지만 Proxmox를 이미 쓰고 있다면 LXC가 더 자연스럽다. 관리 포인트도 적고 오버헤드도 낮다.
