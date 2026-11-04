/**
 * The values to play with for the robotic hands in the home hero.
 */

/**
 * The size of the whole scene on the page: the hands, the arms and the disc. They keep
 * their place in the space beside the content.
 * 1 is the size until 2026-11-04: a disc 99 CSS pixels wide on a wide window, and 51 on
 * the smallest window. 0.7 is 30% smaller. To go back, set this to 1.
 */
export const SCENE_SIZE = 0.7

/**
 * The speed of the whole animation: the hands, the disc and its spin.
 * 1 is the motion as `flight.ts` writes it. 0.6 is 40% slower. 1.5 is 50% faster.
 */
export const ANIMATION_SPEED = 1

/**
 * The seconds that a hand holds the disc before it throws, at speed 1. A longer wait
 * makes the game calmer, and the throws stay just as fast.
 */
export const REST_BETWEEN_THROWS = 1.2

/**
 * The chance that a catch becomes a trick, from 0 (never) to 1. With the limit below,
 * 0.5 gives a trick in about 2 of 3 catches.
 */
export const TRICK_CHANCE = 0.5

/**
 * The most normal catches in a row. After this many, the next catch is a trick for
 * sure, so a visitor never waits long for one. 1 means that a normal catch never comes
 * twice in a row.
 */
export const MAX_NORMAL_CATCHES = 1

/** The seconds that the disc spins on the fingertip in the finger spin trick, at speed 1. */
export const TRICK_SPIN_SECONDS = 2.2

/** The seconds that the disc takes to slide from the fingers to the wrist in the back roll trick, at speed 1. */
export const BACK_ROLL_SECONDS = 0.95

/** How high the hand tosses the disc at the end of the back roll trick, in world units. A hand is about 6. */
export const BACK_TOSS_HEIGHT = 7

/** The seconds of the orbit in the magnetic orbit trick, at speed 1. */
export const ORBIT_SECONDS = 2.1

/** The full laps of the disc around the hand in the magnetic orbit trick. The disc then needs most of one more lap to reach the grip. */
export const ORBIT_LAPS = 2

/** The seconds that the disc floats in the air in the Force trick, at speed 1. */
export const FORCE_HOLD_SECONDS = 1.5

/** How hard a click knocks a hand, in world units. A hand is about 6. */
export const KICK_SHOVE = 5.5

/** The hard jabs of the angry "why?!" after a click on a hand. */
export const WHY_JABS = 4

/** The seconds of one jab of the "why?!", at speed 1. Less is angrier. */
export const WHY_JAB_SECONDS = 0.25

/** How high a jab of the "why?!" goes, in world units. */
export const WHY_JAB_HEIGHT = 2.6

/** How fast a dropped disc falls: its gain in speed each second, in world units. */
export const DROP_GRAVITY = 150

/** The share of its speed that a dropped disc keeps at a bounce, from 0 (no bounce) to 1. */
export const DROP_BOUNCE = 0.42

/**
 * How far the hands are from the side of the page, as a share of the distance that
 * puts them in the middle of the empty space. 1 is the middle. 0.7 is 30% closer to
 * the side.
 */
export const EDGE_DISTANCE = 0.7
