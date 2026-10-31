// Key rules: "day_" keys show in light mode, "night_" keys show in dark mode (see BackgroundPicker).
// The label in the picker is the part after the prefix, with spaces before capitals.
// The FIRST key of each kind is what the dark/light toggle switches to, so keep the calmest one first.
import Sandstone from './day_Sandstone.jpg'
import PaleStone from './day_PaleStone.jpg'
import Studio from './night_Studio.jpg'
import Obsidian from './night_Obsidian.jpg'
import Foil from './night_Foil.jpg'
import PlasterWall from './night_PlasterWall.jpg'

export const DefaultBackgrounds = {
  day_Sandstone: Sandstone,
  day_PaleStone: PaleStone,
  night_Studio: Studio,
  night_Obsidian: Obsidian,
  night_Foil: Foil,
  night_PlasterWall: PlasterWall,
}
