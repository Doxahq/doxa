/**
 * The large pixel "DOXA" at the bottom of the marketing footer.
 *
 * Each row is one line of cells: "#" a solid cell, "+" an edge cell (the glyph covers
 * only part of it), "*" a spark cell in the accent color, and a space an empty cell.
 * The grid is the word in Geist Mono 700 with -0.05em tracking, sampled at 34 cells
 * for the cap height. From half the height down, cells drop out with a fixed noise,
 * so the word dissolves into scattered pixels at the bottom.
 */
export const FOOTER_MARK_ROWS: readonly string[] = [
  " +++++++++                      +#######+         ++++++           ++++++          +++++++         ",
  "+#############+               +###########+      +#######         #######         +########        ",
  "+###############+            ###############      #######+       +#######         #########        ",
  "+#################          #################     +#######       #######+         #########+       ",
  "+##################        ##################+     #######+      #######         +##########       ",
  "+###################      +###################     +#######     +######+         ###########       ",
  "+####################     ########    +########     #######     #######          ###########+      ",
  "+######     +########+   +#######      +#######     +######+   +######+          ###########+      ",
  "+######       ########   #######        +######+     #######   #######          +############      ",
  "+######        #######   #######         #######     +######+ +######+          #############      ",
  "+######        #######+ +######+         #######      ####### #######           ######+######+     ",
  "+######         ####### +######          #######      +######+######+          +###### #######     ",
  "+######         ####### #######          +######+      #############           +###### +######     ",
  "+######         ####### #######          +######+      +###########+           ######+  ######     ",
  "+######         +######+#######          +######+       ###########            ######   ######+    ",
  "+######         +######+#######           ######+       ###########           +######   +######    ",
  "+######         +######+#######           #######        #########            #######   +######    ",
  "+######         +######+#######           #### ##        ##*######            ######+    ######+   ",
  "+#####          +###*##+#######           *#####+       ######## ##           ######     ######+   ",
  "+######         +#*#*##+#######          +######        ##########*          +# # ##     +# ####   ",
  "+ #####         ######  #######          +#####**      ########### #         #######++++++######   ",
  " #### #         ### ### #### *#          +## ###+      #### ###### *         ###################   ",
  "+  ####         ######* + ####            # ####      #######+######+       +#### ##*##*#* #### #  ",
  "+#  ###        + ### #+ +###  #+         # # *#       ## ## #  #### #       +######## ###### # ##  ",
  " ###  #        # *##* +  ## ####         ## ####     + #####  + ###*#+        ### ######### #####  ",
  " ### *#       ##  ##*#   # #####           # ##+     #*## ##   ###* #       # # ##  #  *  #*## ##  ",
  "+ #####         #####    +######        *# #  #      ## # #    + #  # +    +## ###   ++  ++   #### ",
  " ###  ## ## ###  ##          #             ####     # # ##      #  #        * ##           +  ## # ",
  "+# # ## #    ####            # * # ## #  #            #  #      ## ###       ### #           * #  +",
  " # # # #  ## #### #        #    #    ###     +     ##  # #       #    ##   ##  ##           ### # +",
  "+  ##   #    #                ##     ####  #      +#   # #           # #   ## #              #  #  ",
  " # #  #  ######              #  # # # #   ##      ##   #                    ##  #            ##  # ",
  "    # ###  #                             #                         #    #                    #    #",
  "   ++ + ++                      +# ###                                         +                   ",
]

export const PIXEL_TONES = ["solid", "edge", "spark"] as const
export type PixelTone = (typeof PIXEL_TONES)[number]

const TONE_BY_CELL: Readonly<Record<string, PixelTone>> = { "#": "solid", "+": "edge", "*": "spark" }

/** The size of the grid, in cells. */
export function pixelGridSize(rows: readonly string[]): { cols: number; rows: number } {
  return { cols: Math.max(0, ...rows.map((row) => row.length)), rows: rows.length }
}

/**
 * One SVG path per tone. Each run of cells with the same tone in a row becomes one
 * rectangle, one unit per cell, so the path stays small. The gaps between the pixels
 * come from a mask, not from the path.
 */
export function pixelPaths(rows: readonly string[]): Record<PixelTone, string> {
  const paths: Record<PixelTone, string[]> = { solid: [], edge: [], spark: [] }
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const tone = TONE_BY_CELL[row.charAt(x)]
      let end = x + 1
      while (end < row.length && row.charAt(end) === row.charAt(x)) end++
      if (tone) paths[tone].push(`M${x} ${y}h${end - x}v1h-${end - x}z`)
      x = end
    }
  })
  return { solid: paths.solid.join(""), edge: paths.edge.join(""), spark: paths.spark.join("") }
}

export type PixelCell = { x: number; y: number; tone: PixelTone }

/** Every filled cell of the grid, row by row. The cursor glow lights these cells. */
export function pixelCells(rows: readonly string[]): PixelCell[] {
  const cells: PixelCell[] = []
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const tone = TONE_BY_CELL[row.charAt(x)]
      if (tone) cells.push({ x, y, tone })
    }
  })
  return cells
}
