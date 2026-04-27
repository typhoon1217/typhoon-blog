---
title: Pack2theRoot 대응기
published: 2026-04-27
description: 운영 중인 Proxmox 환경에서 CVE-2026-41651에 취약한 LXC 컨테이너를 발견하고 제거한 이야기. autoremove로 자동 업데이트 데몬을 실수로 날린 사건까지.
tags:
  - infra
  - linux
  - proxmox
  - security
  - korean
category: Infra
draft: false
---

Proxmox dev 환경에 깔린 LXC 컨테이너 6개 중 3개가 며칠 전 공개된 CVE에 취약했다. 흥미로운 건 6개 모두 Ubuntu 24.04인데 정확히 .3 포인트 릴리스 컨테이너만 영향이라는 점이다.

## Pack2theRoot가 뭔가

4월 22일에 공개된 CVE-2026-41651. 별칭이 Pack2theRoot다. CVSS 8.8 HIGH.

12년 동안 잠복한 취약점이다. PackageKit 코드 3곳에서 경쟁 조건이 발생한다. 비특권 로컬 사용자가 polkit 인증을 우회해서 RPM 설치/제거는 물론 RPM scriptlet을 root 권한으로 실행할 수 있다.

한마디로 PackageKit이 깔려 있으면 끝이다.

영향을 받는 버전은 1.0.2(2014-11)부터 1.3.4까지. 12년 간 방치됐다는 뜻이다. 수정은 1.3.5에서.

배포판 패치 상황은 들쑥날쑥했다. Debian은 이미 DSA-6226-1로 Bookworm/Trixie를 보호했고 DLA-4545-1로 Bullseye까지 커버했다. 그런데 Ubuntu는 모든 릴리스가 "Needs evaluation" 상태라서 패치가 나오지 않았다. Red Hat 쪽도 RHSA 대기 중이었다.

## 우리 환경 점검

호스트는 Proxmox VE 9.1.1에 Debian 13 Trixie. PackageKit은 처음부터 설치 안 되어 있다. 안전하다.

문제는 LXC 컨테이너다. 6개가 있었다.

| 컨테이너 | OS | PackageKit |
|---|---|---|
| A | Ubuntu 24.04 | 미설치 |
| B | Ubuntu 24.04 | 미설치 |
| C | Ubuntu 24.04.3 | **1.2.8-2ubuntu1.5 (취약)** |
| D | Ubuntu 24.04.3 | **1.2.8-2ubuntu1.5 (취약)** |
| E | Ubuntu 24.04.3 | **1.2.8-2ubuntu1.5 (취약)** |
| F | Ubuntu 24.04 | 미설치 |

패턴이 명확했다. 24.04.3 포인트 릴리스 컨테이너만 PackageKit이 있다.

원인을 파고들었다. software-properties-common의 Recommends에 packagekit이 있다. APT의 기본 설정(Install-Recommends "true")이 자동으로 설치하는 거다. Proxmox LXC 템플릿이 24.04.3 시점에 software-properties-common을 포함하도록 변경되면서 생긴 부작용이다. 초기 24.04 릴리스 컨테이너들은 software-properties-common 없이 만들어졌던 거다.

## 제거 — 그리고 autoremove 사고

3개 컨테이너 모두 서비스는 static + inactive 상태였다. 자동 시작도 안 되고 지금 구동 중도 아니었다. D-Bus 활성화 흔적을 보니 4월 26-27일 무렵 5분짜리 lifetime이 몇 번 있었다. unattended-upgrades나 update-notifier가 daily check를 하면서 깼던 흔적이다.

사전 시뮬레이션을 철저히 했다. `apt-get remove`로 이 3개 패키지가 뭘 끌어내리는지 확인했다.

```bash
apt-get -s remove packagekit packagekit-tools software-properties-common
```

정확히 3개라고 나왔다. 의존성도 깔끔하게 정리됐다. add-apt-repository 사용 흔적도 전혀 없었다(cron, ansible, cloud-init, /opt, /usr/local, bash_history 모두 0건). 기존 PPA 파일들은 add-apt-repository 없이도 정상 작동한다. 제거 안전하다고 판단했다.

실행했다.

```bash
apt-get remove --purge packagekit packagekit-tools software-properties-common && apt-get autoremove --purge
```

그다음이 문제였다.

autoremove cascade가 시뮬레이션 예상과 달랐다. 3개만 사라지는 게 아니라 11개가 사라졌다.

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

**unattended-upgrades가 같이 사라졌다.**

자동 보안 패치 데몬이 날아갔다는 뜻이다.

원인을 짚었다. `apt-get -s remove` 시뮬레이션은 직접 제거한 패키지만 보여준다. autoremove가 뭘 정리할지는 별도 시뮬레이션이 필요했는데 그걸 빠뜨렸다. 두 단계를 따로따로 봤어야 한다.

```bash
apt-get -s remove [패키지들]
apt-get -s autoremove
```

## 복구

cascading 피해를 최소화했다.

먼저 unattended-upgrades를 다시 깔았다. 이번엔 APT Recommends 함정에 안 빠지도록 `--no-install-recommends`를 붙였다.

```bash
apt-get install -y --no-install-recommends unattended-upgrades
```

packagekit이 다시 끌려오지 않았다.

다음, unattended-upgrades를 `apt-mark manual`로 표시했다. 향후 autoremove 보호용이다.

```bash
apt-mark manual unattended-upgrades
```

/etc/apt/apt.conf.d/20auto-upgrades 파일을 재생성해서 자동 업데이트를 다시 활성화했다.

```
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

systemd 타이머도 다시 켰다.

```bash
systemctl enable apt-daily.timer apt-daily-upgrade.timer
systemctl enable unattended-upgrades.service
```

약 2-3분의 자동 업데이트 윈도우를 손실했다.

## 배운 점

한 가지가 명확했다. APT의 Recommends는 기본 활성화다. 서버에 GUI 성향의 데몬이 줄줄이 깔린다는 뜻이다. 처음부터 `/etc/apt/apt.conf.d/99-no-recommends`로 막거나 설치할 때 `--no-install-recommends`를 매번 쓰는 게 낫다.

autoremove는 두 단계로 검증해야 한다. `apt-get -s remove`와 `apt-get -s autoremove`를 모두 봐야 한다. 중요한 패키지는 `apt-mark manual`로 보호하는 게 안전하다.

마지막으로 한 가지 깨달음. static + inactive 서비스도 D-Bus activation으로 깨워진다. 진정한 면역은 패키지 부재다. PackageKit을 처음부터 설치 안 하면 미래의 PackageKit CVE는 영향을 받지 않는다. 공격면 최소화다.
