// JS \w and \b are ASCII only, also with the u flag.
const WORD = String.raw`[\p{L}\p{N}_]`
const B = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`

/** A question that names an article, recital or annex by its number. */
export const NAMES_A_UNIT = new RegExp(
  `${B}(?:arts?|articles?|artyku[łl]${WORD}*|recitals?|motyw${WORD}*|annex(?:es)?|załącznik${WORD}*)${B}` +
    String.raw`\.?\s*\(?(?:[0-9]+|(?-i:[IVXLC]+)${B})`,
  'iu',
)
