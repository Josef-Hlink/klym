# Build tooling for the klym Connect IQ data field. The SDK itself is a
# manual one-time install via Garmin's SDK Manager (see README.md); its
# location is read from the SDK Manager's current-sdk.cfg.

SDK_CFG := $(HOME)/Library/Application Support/Garmin/ConnectIQ/current-sdk.cfg
SDK := $(shell cat "$(SDK_CFG)" 2>/dev/null)
KEY ?= $(HOME)/.config/garmin/developer_key.der
DEVICE ?= edge540
TOKEN_FILE ?= secrets.token
PRG := bin/klym.prg

BASE_URL ?= https://klym.hlink.dev
SIM_BASE_URL ?= http://127.0.0.1:1047

.PHONY: build sim sideload config sim-config clean

# Device config: real server + the token from secrets.token (gitignored).
config:
	@test -f $(TOKEN_FILE) || { echo "missing $(TOKEN_FILE) — put the KLYM_GARMIN_TOKEN value in it"; exit 1; }
	@sed -e "s|__KLYM_BASE_URL__|$(BASE_URL)|" -e "s|__KLYM_TOKEN__|$$(cat $(TOKEN_FILE))|" \
		Config.mc.template > source/Config.mc
	@echo "source/Config.mc -> $(BASE_URL)"

# Simulator config: the pnpm dev server on :1047 with the .env devtoken.
sim-config:
	@sed -e "s|__KLYM_BASE_URL__|$(SIM_BASE_URL)|" -e "s|__KLYM_TOKEN__|devtoken|" \
		Config.mc.template > source/Config.mc
	@echo "source/Config.mc -> $(SIM_BASE_URL) (devtoken)"

# Builds with whatever source/Config.mc is present (sim-config if none yet);
# run `make config build` explicitly for a device build.
build:
	@test -n "$(SDK)" || { echo "Connect IQ SDK not found — install it via the SDK Manager (README.md)"; exit 1; }
	@test -f source/Config.mc || $(MAKE) sim-config
	@mkdir -p bin
	"$(SDK)/bin/monkeyc" -f monkey.jungle -d $(DEVICE) -o $(PRG) -y "$(KEY)" -w -l 0

sim: sim-config build
	"$(SDK)/bin/connectiq" || true
	sleep 3
	"$(SDK)/bin/monkeydo" $(PRG) $(DEVICE)

sideload: config build
	@test -d /Volumes/GARMIN/Garmin/Apps || { echo "Edge not mounted at /Volumes/GARMIN — if it's in MTP mode, copy $(PRG) to Garmin/Apps with OpenMTP instead"; exit 1; }
	cp $(PRG) /Volumes/GARMIN/Garmin/Apps/
	@echo "sideloaded — eject the Edge before unplugging"

clean:
	rm -rf bin source/Config.mc
