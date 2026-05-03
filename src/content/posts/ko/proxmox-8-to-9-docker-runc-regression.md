---
title: Proxmox 8에서 9로 옮기다 도커가 깨진 이야기
published: 2026-05-04
description: PVE 8.4를 9.1.9로 올리는 과정에서 만난 docker/runc 회귀와 sudo CVE-2026-35535 처리 기록.
tags:
  - linux
  - security
  - proxmox
  - docker
  - lxc
  - infra
  - homelab
  - korean
category: 인프라
draft: false
featured: true
---

홈랩 Proxmox 호스트가 1년 가까이 패치를 못 받고 있었다. 커널 6.8.12-9-pve, sudo CVE-2026-35535도 미패치. 하루 안에 점검부터 PVE 9 마이그레이션까지 끝낼 작정이었는데, 중간에 도커가 통째로 깨졌다.

## scan-all-cves가 던진 5개 이슈

직접 만든 12개 CVE 게이팅 스크립트가 [VULN]/[WARN]을 5개 띄웠다.

- CVE-2026-31431 — Copy Fail, AF_ALG 커널 LPE
- CVE-2026-23113 — io_uring race
- CVE-2026-32202 — NTLM coercion via CIFS
- CVE-2026-35414 — OpenSSH SplitSSHell
- CVE-2026-35535 — sudo privilege drop

AF_ALG 차단은 5분이면 끝났다. modprobe.d에 `install af_alg /bin/false`를 박아 autoload 막고, 이미 로드된 모듈은 unload. 재부팅 무관.

```bash
# /etc/modprobe.d/disable-algif-cve-2026-31431.conf
install af_alg /bin/false
install algif_aead /bin/false
install algif_skcipher /bin/false
install algif_hash /bin/false
install algif_rng /bin/false
```

이 정도가 평소의 패치 작업이다. 진짜 문제는 그 다음이었다.

## LXC를 패치했더니 도커가 다 죽었다

LXC 11개에 `apt dist-upgrade -y`를 돌렸다. docker-ce가 28.1.1 → 28.5.2, containerd.io가 1.7.x → 2.2.3으로 같이 메이저 점프. 작업 끝나고 컨테이너 상태를 보니:

```
Error response from daemon: failed to create task for container:
  failed to create shim task: OCI runtime create failed:
  runc create failed: unable to start container process:
  error during container init:
  open sysctl net.ipv4.ip_unprivileged_port_start file:
  reopen fd 8: permission denied
```

vaultwarden, nextcloud, keycloak, 모든 portainer 인스턴스. 11개 LXC 전부 시작 실패.

원인은 docker가 아니라 **runc 1.1.x → 1.3.3의 OCI spec 변경**이었다. 새 runc는 spec 1.2.1을 따라 unprivileged user namespace에서 `ip_unprivileged_port_start` sysctl을 reset하려 한다. 그런데 PVE 8.4의 unprivileged LXC는 `/proc/sys`를 read-only로 마운트한다. write 시도 → permission denied → 컨테이너 init 자체가 실패.

처음엔 docker-ce만 다운그레이드하면 풀릴 줄 알았다. 그런데 docker 28에서도 같은 containerd.io 2.x를 쓰면 결국 runc 1.3을 번들. 두 가지 모두 다운그레이드하고 hold로 묶어야 했다.

```
docker-ce            5:28.1.1-1~ubuntu.24.04~noble
docker-ce-cli        5:28.1.1-1~ubuntu.24.04~noble
docker-ce-rootless-extras  5:28.1.1-1~ubuntu.24.04~noble
containerd.io        1.7.18-1   # runc 1.1.13 번들
```

`apt-mark hold`로 6개 패키지를 잠그고 나서야 모든 컨테이너가 다시 떴다. 첫 패치 시도부터 복구까지 1시간 30분 날렸다.

## PVE 9으로 올렸더니 자연스럽게 풀렸다

이 시점에 사용자가 "PVE 9 메이저도 할 만하지 않냐"고 물었다. 따져보니 sudo CVE-2026-35535는 Debian 12 stable이 fix를 backport 안 한 상태였다. unstable의 sudo 1.9.17p2는 `libc6 ≥ 2.42`를 요구하는데 bookworm은 2.36이다. libc 강제 업그레이드는 시스템 자살이라 사실상 막혀있었다. PVE 9 = Debian 13 trixie로 가야 풀린다.

`pve8to9` 사전 점검에서 1개 FAIL이 나왔다 — 잔존 ceph cluster가 너무 오래됐다는 것. 그런데 실태를 보니 OSD 0, pool 0, object 0의 텅 빈 cluster. 어느 시점에 mon/mgr만 띄우고 방치됐던 모양. `pveceph mon destroy` + `pveceph purge`로 정리하니 0 FAIL.

`vzdump`로 12개 게스트(11 LXC + 1 VM)를 통째로 백업(zstd 압축으로 17GB), 그리고 dist-upgrade. 800+ 패키지 갱신, 호스트 reboot, kernel 7.0.0-3-pve로 부팅.

신기한 건 **PVE 9에서는 docker hold를 풀어도 잘 돈다**는 것이었다. 같은 unprivileged LXC인데 PVE 9의 LXC userns는 sysctl write를 허용한다. docker 29.4.2 + containerd.io 2.2.3 + runc 1.3.3 조합으로 모든 컨테이너 정상. 회귀가 자연스럽게 사라졌다.

검증 결과:

- sudo: 1.9.13p3 (vuln) → **1.9.16p2-3+deb13u1** (CVE-2026-35535 fixed)
- 호스트 trivy CRIT+HIGH: 142 → **60** (-58%)
- scan-all-cves 12개 중 [OK] 9개

## detect.sh가 만드는 거짓 [VULN]

남은 [VULN] 두 개는 모두 glibc CVE인데 Debian changelog를 직접 보면 fix가 들어있다.

```
$ zcat /usr/share/doc/libc6/changelog.Debian.gz | grep -i CVE-2026-0861
  (CVE-2026-0861).  Closes: #1125678.
```

detect.sh는 distro별 cutoff version만 비교하기 때문에 Debian이 silent backport한 패치를 못 잡는다. CVE-2026-35535도 비슷하다. Debian이 "minor issue"로 분류해 DSA를 안 냈다. 이유는 Debian sudo가 `--disable-root-mailer` 컴파일 플래그로 빌드돼서 취약 코드 path가 바이너리에 아예 없기 때문이다. 즉 detect는 [VULN]이지만 실제 exploit는 0. 이건 시스템별 컴파일 플래그까지 봐야 알 수 있다.

scan 결과를 그대로 받지 말고 changelog와 binary를 한 번 더 보는 게 맞다.

## CVE만 보면 한쪽 면만 보는 거다

PVE 9까지 올리고 나서 Lynis, ssh-audit, Docker Bench for Security를 돌렸다.

- Lynis hardening index: **64/100** (60-80 = improve 영역)
- ssh-audit: NIST P-256/384/521 curves + SHA-1 MAC이 [fail] 6개
- Docker Bench score: **11/105**

CVE는 거의 다 잡아놓고도 fail2ban 미설치, GRUB password 미설정, Docker daemon auditd 미적용, sshd가 weak 알고리즘 advertise 같은 holes가 가득. CVE만 보면 한 면만 보는 셈이었다.

`fail2ban` 설치 + 기본 jail 5분, sshd에 강한 KEX/Cipher/MAC만 명시 5분, password policy 한 줄, auditd로 Docker 디렉토리 watch. 단발 CVE 패치보다 이런 자질구레한 hardening이 사실 더 큰 risk reducer였다.

## 마무리

하루 안에 PVE 8.4 → PVE 9.1.9, 호스트 + 11 LXC 일괄 패치, docker 회귀 진단 + 복구, CVE 외 hardening까지 끝냈다. 핵심 교훈 네 가지.

- **메이저 업그레이드를 미루지 말 것**. PVE 9까지 가야 풀리는 CVE가 있다 (sudo 35535은 libc 2.42 요구).
- **회귀는 같이 deploy되는 다른 패키지에서 온다**. docker만 본 줄 알았는데 실은 containerd.io 번들의 runc가 문제. apt dist-upgrade의 사이드 effect를 항상 의심하자.
- **scan tool은 보수적인 default**를 쓴다. [VULN]을 그대로 받지 말고 changelog + binary compile flag까지 봐야 진짜 위험을 안다.
- **CVE 외 영역도 같이 보지 않으면** 패치만 잘 한 약한 시스템이 된다. Lynis 한 번 돌리는 비용은 5분이다.
