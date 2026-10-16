"""Constants for Housemate Brain."""

DOMAIN = "housemate"
CONF_HOST = "host"
CONF_PORT = "port"
CONF_NAME = "name"
# The Housemate app runs on the HA host (host network) and announces itself with these.
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 10311
TURN_PATH = "/assist/turn"
# Satellite states the Voice Loop pauses and plays the dot's music on (asst M4). Its answer to idle can
# be {"beep_then_listen": true}: a voice training sentence was just said (nook N4).
MUSIC_PATH = "/assist/music"
MUSIC_STATES = ("listening", "idle")
# Voice training's beep, served by this integration (scripts/make_training_beep.py): the satellite
# plays it and listens, whatever TTS the house uses.
TRAINING_BEEP_FILE = "training_beep.wav"
TRAINING_BEEP_URL = f"/api/{DOMAIN}/static/{TRAINING_BEEP_FILE}"
# Calibration (asst M6): the dot's API action that starts a session, and its event when it is over
# (data `takes`). The takes leave the dot from the Voice Loop.
CALIBRATION_PATH = "/assist/calibration"
CALIBRATE_ACTION = "calibrate"
CALIBRATION_DONE_EVENT = "esphome.localdot_calibration_done"
# A calibration start waits this long at most for the reply that announced it to finish.
CALIBRATION_START_KEEP_SECONDS = 60
# A turn can run as long as a spoken answer does.
TURN_TIMEOUT_SECONDS = 200
# A LocalDot fires this as each Assist run starts: data `start` ("wake" or "button") and `wake_word`.
# The turn API confirms and strips a "Hey <name>" wake from the words (asst M3).
START_EVENT = "esphome.localdot_turn_start"
# A start not claimed by a turn within this long (the run never reached the agent) is stale.
START_KEEP_SECONDS = 120
