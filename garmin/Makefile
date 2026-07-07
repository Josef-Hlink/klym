# Build tooling for the klym Connect IQ data field. The SDK itself is a
# manual one-time install via Garmin's SDK Manager (see README.md); its
# location is read from the SDK Manager's current-sdk.cfg.

SDK_CFG := $(HOME)/Library/Application Support/Garmin/ConnectIQ/current-sdk.cfg
SDK := $(shell cat "$(SDK_CFG)" 2>/dev/null)
KEY ?= $(HOME)/.config/garmin/developer_key.der
DEVICE ?= edge540
PRG := bin/klym.prg
IQ := bin/klym.iq

SIM_BASE_URL ?= http://127.0.0.1:1047

.PHONY: build package sim sideload config sim-config clean

# Sim-only self-riding mode; device builds always get false.
DEMO ?= false

# Store/device config: no baked secrets — server URL and token come from
# the Connect IQ app settings (set in Garmin Connect on the phone).
config:
	@sed -e "s|__KLYM_BASE_URL__||" -e "s|__KLYM_TOKEN__||" \
		-e "s|__KLYM_DEMO__|false|" \
		Config.mc.template > source/Config.mc
	@echo "source/Config.mc -> store (URL + token from app settings)"

# Simulator config: the pnpm dev server on :1047 with the .env devtoken.
# DEMO=true makes the field ride the route by itself when playback is off.
sim-config:
	@sed -e "s|__KLYM_BASE_URL__|$(SIM_BASE_URL)|" -e "s|__KLYM_TOKEN__|devtoken|" \
		-e "s|__KLYM_DEMO__|$(DEMO)|" \
		Config.mc.template > source/Config.mc
	@echo "source/Config.mc -> $(SIM_BASE_URL) (devtoken, demo=$(DEMO))"

# Builds with whatever source/Config.mc is present (sim-config if none yet);
# run `make config build` explicitly for a device build.
build:
	@test -n "$(SDK)" || { echo "Connect IQ SDK not found — install it via the SDK Manager (README.md)"; exit 1; }
	@test -f source/Config.mc || $(MAKE) sim-config
	@mkdir -p bin
	"$(SDK)/bin/monkeyc" -f monkey.jungle -d $(DEVICE) -o $(PRG) -y "$(KEY)" -w -l 0

# Store package: exported, release-mode .iq for upload to the Connect IQ
# store (https://apps.garmin.com/developer/dashboard).
package: config
	@test -n "$(SDK)" || { echo "Connect IQ SDK not found — install it via the SDK Manager (README.md)"; exit 1; }
	@mkdir -p bin
	"$(SDK)/bin/monkeyc" -f monkey.jungle -e -r -o $(IQ) -y "$(KEY)" -w
	@echo "$(IQ) ready for store upload"

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
