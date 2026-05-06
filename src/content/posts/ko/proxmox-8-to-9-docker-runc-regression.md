---
title: PVE 8.4에서 docker가 깨진 이야기 — 진짜 범인은 runc였다
published: 2026-05-04
description: unprivileged LXC에 apt dist-upgrade를 돌렸더니 모든 docker 컨테이너가 init에 실패했다. 같이 묶여 들어온 runc 1.3의 OCI spec 변경이 PVE 8.4의 read-only /proc/sys와 충돌한 것이 원인.
tags:
  - linux
  - proxmox
  - docker
  - lxc
  - runc
  - infra
  - homelab
  - korean
category: 인프라
draft: false
featured: true
---

11개 LXC에 dist-upgrade를 한 번 돌렸더니 vaultwarden, nextcloud, keycloak — 모든 docker 컨테이너가 시작에 실패했다. 처음엔 당연히 docker 문제인 줄 알았는데, 실제 범인은 같이 묶여 들어온 runc였다.

## 11개 LXC를 한꺼번에 패치했더니 도커가 다 죽었다

홈랩 Proxmox 호스트(PVE 8.4)에서 LXC 11개 모두 unprivileged 컨테이너로 docker 워크로드를 띄워놓고 있었다. 패치를 한참 미뤄오다가 한꺼번에 정리하기로 하고, 각 컨테이너에 `apt dist-upgrade -y`. 800개 가까운 패키지가 갱신됐고, 그 안에 docker-ce 28.1.1 → 28.5.2, containerd.io 1.7 → 2.2.3 같은 메이저 점프가 들어 있었다.

작업이 끝나고 컨테이너 상태를 보니:

```
Error response from daemon: failed to create task for container:
  failed to create shim task: OCI runtime create failed:
  runc create failed: unable to start container process:
  error during container init:
  open sysctl net.ipv4.ip_unprivileged_port_start file:
  reopen fd 8: permission denied
```

vaultwarden, nextcloud, keycloak, 모든 portainer 인스턴스가 같은 에러로 시작에 실패했다. 11개 LXC 어디서 봐도 동일한 메시지였다.

## 원인은 docker가 아니라 runc 1.3의 sysctl reset이었다

처음 30분은 docker daemon 로그만 들여다봤다. 답이 안 나와서 OCI 메시지를 처음부터 다시 읽으니 핵심은 "sysctl ... permission denied"였다. docker가 아니라 *그 아래 layer*에서 발생하는 권한 거부라는 뜻이다.

묶음 업그레이드된 의존성을 따져보니 containerd.io 2.x가 runc 1.3을 번들링하고 있었다. runc 1.1 → 1.3은 OCI runtime spec 1.2.1을 따르는데, 이 spec 변경의 일부가 컨테이너 init 시점에 `net.ipv4.ip_unprivileged_port_start` sysctl을 *기본값으로 reset*하는 동작이다.

일반적인 호스트면 문제없다. 그런데 PVE 8.4의 unprivileged LXC는 보안상 `/proc/sys`를 read-only로 마운트한다. 새 runc가 reset을 시도 → write 거부 → init 실패 → 컨테이너 통째로 죽음.

요약하면 docker에는 버그가 없다. 한 번에 같이 올라온 runc가 unprivileged LXC + read-only sysfs라는 환경에서 OCI spec 변경 때문에 작동을 못 할 뿐이다.

## 응급조치 — 6개 패키지 다운그레이드 + hold

처음엔 docker-ce만 28.1로 되돌리면 풀릴 줄 알았다. 그런데 docker 28에서도 같은 containerd.io 2.x를 require하면 결국 runc 1.3을 끌어온다. 둘 다 함께 다운그레이드하고 묶어두는 수밖에 없었다.

```
docker-ce                  5:28.1.1-1~ubuntu.24.04~noble
docker-ce-cli              5:28.1.1-1~ubuntu.24.04~noble
docker-ce-rootless-extras  5:28.1.1-1~ubuntu.24.04~noble
containerd.io              1.7.18-1     # runc 1.1.13 번들
docker-buildx-plugin       0.14.x
docker-compose-plugin      2.27.x
```

`apt-mark hold`로 6개 패키지를 잠그고 컨테이너를 다시 시작하니 모두 정상 기동. 첫 패치 시도부터 복구까지 1시간 30분이 날아갔다.

## PVE 9에서는 같은 조합이 정상 동작한다

이 상태로 두면 다음 보안 패치 사이클마다 같은 hold가 발목을 잡는다. 진짜 해결은 호스트 쪽에 있을 것 같았다. 마침 PVE 9.1.9가 한 달째 안정 단계였다.

`pve8to9` 사전 점검에서 FAIL이 한 개 — 잔존 ceph cluster가 너무 오래됐다는 것. 그런데 살펴보니 OSD 0, pool 0, object 0의 텅 빈 cluster였다. 어느 시점에 mon/mgr만 띄우고 잊어버린 모양이다. `pveceph mon destroy` + `pveceph purge`로 정리하니 0 FAIL.

`vzdump`으로 12 게스트(11 LXC + 1 VM)를 백업(zstd 17GB), 그리고 dist-upgrade. 800+ 패키지 갱신, 호스트 reboot, 커널 7.0.0-3-pve로 부팅.

여기서 흥미로운 일이 벌어졌다. **PVE 9에서는 docker hold를 풀어도 잘 돈다.** 같은 unprivileged LXC인데 PVE 9의 LXC 4.x userns는 sysctl write를 허용하도록 동작이 바뀌어 있다. docker 29.4.2 + containerd.io 2.2.3 + runc 1.3.3 조합으로 11개 컨테이너 모두 정상 기동. 회귀가 호스트 메이저 업그레이드와 함께 자연스럽게 풀린 셈이다.

## 교훈 — apt dist-upgrade는 묶음 회귀를 의심하라

단일 docker 회귀처럼 보였던 것이 실제로는 호스트 환경(unprivileged LXC userns 정책)과 새 spec(OCI 1.2.1)의 미스매치였다. docker 자체에는 버그가 없고, runc 1.3에도 버그는 없으며, PVE 8.4의 read-only sysfs도 의도된 보안 정책이다. 셋이 동시에 만나니 깨졌다.

이런 회귀는 다음 두 곳에서 자주 온다.

- **묶음 의존성의 메이저 점프** — `apt dist-upgrade`는 명시적으로 설치한 패키지 외에도 의존성 트리 전체를 메이저 단위로 끌어올린다. docker만 보고 있으면 containerd.io/runc의 변화를 놓친다.
- **컨테이너 런타임 + 호스트 격리 정책의 조합** — OCI spec 변경은 standalone Linux에서는 문제없지만, hypervisor의 격리된 환경에서는 새로운 권한이 필요해진다. unprivileged LXC, gVisor, Kata 같은 환경은 같은 spec 업데이트에 더 민감하다.

가장 큰 교훈은 메이저 업그레이드를 미루는 게 안전한 길이 아니라는 점. 1년치 업그레이드를 한 번에 받으면 1년치 회귀도 한 번에 온다. 자주 받으면 회귀가 터져도 *어떤 변화 때문인지* 좁히기 쉽다. 이번에 잃은 1시간 30분이 그걸 가르쳐 줬다.
