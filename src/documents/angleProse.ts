// Standard names can have boolean attributes. Their spelling alone must never turn them into prose.
const markupNames = new Set(
  "a abbr acronym address animate animatemotion animatetransform annotation annotation-xml applet area article aside audio b base basefont bdi bdo bgsound big blink blockquote body br button canvas caption center circle cite clippath code col colgroup data datalist dd defs del desc details dfn dialog dir div dl dt ellipse em embed feblend fecolormatrix fecomponenttransfer fecomposite feconvolvematrix fediffuselighting fedisplacementmap fedistantlight fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur feimage femerge femergenode femorphology feoffset fepointlight fespecularlighting fespotlight fetile feturbulence fieldset figcaption figure filter font footer foreignobject form frame frameset g h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe image img input ins isindex kbd keygen label legend li line lineargradient link listing maction main map mark marker marquee mask math menu menuitem merror meta metadata meter mfrac mi mmultiscripts mn mo mover mpadded mpath mphantom mprescripts mroot mrow ms mspace msqrt mstyle msub msubsup msup mtable mtd mtext mtr multicol munder munderover nav nextid nobr noembed noframes noscript object ol optgroup option output p param path pattern picture plaintext polygon polyline pre progress q radialgradient rb rect rp rt rtc ruby s samp script search section select semantics set slot small source spacer span stop strike strong style sub summary sup svg switch symbol table tbody td template text textarea textpath tfoot th thead time title tr track tspan tt u ul use var video view wbr xmp".split(
    " "
  )
)

/** Recognize an unpaired prose instruction, never a tag with structural evidence. */
export function angleProseEnd(text: string, start: number): number | undefined {
  if (text[start] !== "<") return
  const end = text.indexOf(">", start + 1)
  if (end < 0) return
  const body = text.slice(start + 1, end)
  if (/[=/'"<>`\r\n]/u.test(body)) return
  const content = body.trim()
  const separator = content.search(/\s/u)
  const name = separator < 0 ? content : content.slice(0, separator)
  const lowerName = name.toLowerCase()
  const asciiName = /^[A-Za-z][A-Za-z\d]*$/u.test(name)
  if (asciiName) {
    if (separator < 0 || name[0] !== name[0].toLowerCase() || markupNames.has(lowerName)) return
  } else if (!/^\p{L}/u.test(body) || ![...body].some((character) => character.codePointAt(0)! > 127)) return
  // A matching closing element makes even an unknown name real markup.
  const close = "</" + lowerName
  const lower = text.toLowerCase()
  for (let position = lower.indexOf(close, end + 1); position >= 0; position = lower.indexOf(close, position + close.length)) {
    const next = lower[position + close.length]
    if (next === ">" || /\s/u.test(next ?? "")) return
  }
  return end + 1
}
