// Invoice models and deterministic validation. `ExtractedInvoice` is what the extractor returns and
// what a reviewer edits (dates, money and quantities as strings or null); `validate(extracted)`
// turns it into a `ValidationResult` with the typed `Invoice` and every rule `Failure`.
export {
  RULES,
  ExtractedInvoice,
  ExtractedLine,
  Failure,
  Invoice,
  Line,
  Party,
  type Rule,
} from './schema.ts'
export { ValidationResult, validate } from './validator.ts'
