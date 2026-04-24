---
title: Ubuntu 커널 업데이트 후 GRUB 쉘에 떨어졌을 때
published: 2026-04-25
description: NVIDIA DKMS 빌드 실패로 커널 엔트리가 깨져 부팅이 안 되는 상황을 라이브 USB와 chroot로 복구한 기록.
tags:
  - linux
  - ubuntu
  - nvidia
  - troubleshooting
  - korean
category: Infrastructure
draft: false
---

Ubuntu 24.04에서 업데이트 한 번 잘못 돌렸다가 GRUB 쉘(`grub>`)까지 떨어졌다. 커널 네 개에 NVIDIA 드라이버 두 버전이 섞여 있던 게 원인이었다. 라이브 USB로 들어가서 30분 안에 복구했다.

## 무슨 일이 있었나

재부팅 직후 유선랜이 잡히지 않았다. `nmcli device status`에서 물리 이더넷(`enp*`)이 통째로 사라지고 가상 장치만 남았다.

```bash
$ lspci -k | grep -A 3 -i ethernet
04:00.0 Ethernet controller: Realtek RTL8111/8168/8211/8411
        Subsystem: ASRock Incorporation Motherboard
        # "Kernel driver in use:" 줄이 없음
```

드라이버가 아예 로드되지 않은 상태. 복구해보겠다고 재부팅하니 이번엔 GNOME이 안 뜨고 TTY로 떨어졌다. 한 번 더 재부팅하자 GRUB 메뉴마저 사라지고 `grub>` 쉘이 나타났다.

## 원인

라이브 USB로 진입해서 확인한 상태:

- 커널 네 개가 동시 설치 (`6.8.0-110`, `6.17.0-14`, `6.17.0-20`, `6.17.0-22`)
- NVIDIA 드라이버가 `nvidia-550`과 `nvidia-580` 두 버전 혼재
- `linux-modules-nvidia-580-6.17.0-22-generic`이 미구성 상태로 남음
- 기본 부팅 커널에 해당 드라이버가 빌드되어 있지 않음

커널은 업데이트됐는데 그 커널용 NVIDIA 모듈은 빌드가 안 된 채로 부팅되면서 그래픽 스택이 초기화되지 못했다. 거기에 dpkg 설정 실패가 누적되며 GRUB 설정까지 불완전하게 생성됐다.

## chroot로 복구

라이브 USB로 부팅해서 **Try Ubuntu** 선택. 파티션 확인:

```bash
$ lsblk
sdb     238G disk
├─sdb1    1G part    # EFI (VFAT)
└─sdb2  237G part    # 루트 (Ext4)
```

루트 `/dev/sdb2`, EFI `/dev/sdb1`. 마운트하고 chroot 진입:

```bash
sudo mount /dev/sdb2 /mnt
sudo mount /dev/sdb1 /mnt/boot/efi
for i in dev proc sys run; do sudo mount --bind /$i /mnt/$i; done
sudo chroot /mnt
```

chroot 안에서 `ping`과 `apt update`로 네트워크 동작을 먼저 확인한다. 그 다음 문제 패키지부터 걷어낸다.

```bash
# 실패한 NVIDIA 모듈 정리
apt remove --purge \
    linux-modules-nvidia-550-generic-hwe-24.04 \
    linux-modules-nvidia-580-generic-hwe-24.04 \
    linux-modules-nvidia-580-6.17.0-22-generic

# 6.17 커널 시리즈 전부 제거
apt remove --purge $(dpkg -l | grep 'linux-.*6\.17' | awk '{print $2}')
apt autoremove --purge
```

안정 커널(HWE 6.8)과 NVIDIA 드라이버를 재설치한다. 여기가 실제 해결점이다.

```bash
apt install --reinstall \
    linux-generic-hwe-24.04 \
    linux-image-6.8.0-110-generic \
    linux-headers-6.8.0-110-generic

apt install --reinstall nvidia-driver-550
```

initramfs와 GRUB을 다시 생성하고 부트로더를 재설치한다.

```bash
update-initramfs -u -k all
update-grub
grub-install /dev/sdb
```

`grub-install`의 대상은 파티션이 아니라 디스크(`/dev/sdb`)다. `/dev/sda`가 아니라 실제 Ubuntu가 설치된 디스크를 지정해야 한다.

빠져나오고 재부팅. USB는 재부팅 직전에 뽑는다.

```bash
exit
sudo reboot
```

GNOME 로그인 화면이 정상으로 뜨면 복구 완료. `uname -r`로 `6.8.0-110-generic`이 올라왔는지, `nvidia-smi`와 `nmcli device status`로 드라이버와 랜카드가 살아났는지 확인한다.

## 재발 방지

같은 일을 두 번 겪지 않으려고 설정한 것들.

**커널과 드라이버 버전 고정**

```bash
sudo apt-mark hold \
    linux-generic-hwe-24.04 \
    linux-image-generic-hwe-24.04 \
    linux-headers-generic-hwe-24.04 \
    nvidia-driver-550 \
    nvidia-dkms-550
```

LTS를 쓰는 이유는 안정성이다. Proposed 저장소에서 최신 커널을 받을 이유가 없다.

**Timeshift 스냅샷**

업데이트 전 3분이면 스냅샷이 찍힌다. 이걸로 30분짜리 복구를 피할 수 있다.

```bash
sudo apt install timeshift
sudo timeshift --create --comments "before kernel update"
```

별도 디스크에 RSYNC로 저장하고 월 2개만 유지하게 설정한다.

**GRUB 메뉴 항상 보이게**

`/etc/default/grub`:

```bash
GRUB_DEFAULT=saved
GRUB_SAVEDEFAULT=true
GRUB_TIMEOUT=5
GRUB_TIMEOUT_STYLE=menu
```

적용은 `sudo update-grub`. 부팅이 깨져도 메뉴에서 이전 커널로 수동 진입할 수 있다.

**Ventoy USB 상시 구비**

하나의 USB에 Ubuntu, SystemRescue, GParted Live를 다 넣어두고 서랍에 박아둔다. 급할 때 다른 PC 찾아서 USB 만드는 시간이 가장 아깝다.

---

LTS 시스템에서 커널 여러 개와 NVIDIA 드라이버 두 버전을 동시에 들고 있으면 언젠가는 터진다. 하나만 고정해두고 스냅샷으로 보험을 들어두면 이런 상황은 대부분 피할 수 있다.
