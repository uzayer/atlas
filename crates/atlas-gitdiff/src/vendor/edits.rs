//! Vendored from `dandavison/delta` `src/edits.rs` (MIT, © 2020 Dan Davison).
//! Line-pairing + token-annotation pass implementing delta's intra-line
//! ("word") diff. Changes from upstream: imports rewired to `super::align`;
//! the `make_lines_have_homolog` helper (which used delta's `MinusPlus` type)
//! and the test module were removed. Algorithm otherwise unchanged.

use regex::Regex;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::align;

/// Infer the edit operations responsible for the differences between a collection of old and new
/// lines. A "line" is a string. An annotated line is a Vec of (op, &str) pairs, where the &str
/// slices are slices of the line, and their concatenation equals the line. Return the input minus
/// and plus lines, in annotated form.
///
/// Also return a specification of the inferred alignment of minus and plus lines: a paired minus
/// and plus line is represented in this alignment specification as
/// (Some(minus_line_index),Some(plus_line_index)), whereas an unpaired minus line is
/// (Some(minus_line_index), None).
///
/// `noop_deletions[i]` is the appropriate deletion operation tag to be used for `minus_lines[i]`;
/// `noop_deletions` is guaranteed to be the same length as `minus_lines`. The equivalent statements
/// hold for `plus_insertions` and `plus_lines`.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::type_complexity)]
pub fn infer_edits<'a, EditOperation>(
    minus_lines: Vec<&'a str>,
    plus_lines: Vec<&'a str>,
    noop_deletions: Vec<EditOperation>,
    deletion: EditOperation,
    noop_insertions: Vec<EditOperation>,
    insertion: EditOperation,
    tokenization_regex: &Regex,
    max_line_distance: f64,
    max_line_distance_for_naively_paired_lines: f64,
) -> (
    Vec<Vec<(EditOperation, &'a str)>>,  // annotated minus lines
    Vec<Vec<(EditOperation, &'a str)>>,  // annotated plus lines
    Vec<(Option<usize>, Option<usize>)>, // line alignment
)
where
    EditOperation: Copy + PartialEq + std::fmt::Debug,
{
    let mut annotated_minus_lines = Vec::<Vec<(EditOperation, &str)>>::new();
    let mut annotated_plus_lines = Vec::<Vec<(EditOperation, &str)>>::new();
    let mut line_alignment = Vec::<(Option<usize>, Option<usize>)>::new();

    let mut plus_index = 0; // plus lines emitted so far

    'minus_lines_loop: for (minus_index, minus_line) in minus_lines.iter().enumerate() {
        let mut considered = 0; // plus lines considered so far as match for minus_line
        for plus_line in &plus_lines[plus_index..] {
            let alignment = align::Alignment::new(
                tokenize(minus_line, tokenization_regex),
                tokenize(plus_line, tokenization_regex),
            );
            let (annotated_minus_line, annotated_plus_line, distance) = annotate(
                alignment,
                noop_deletions[minus_index],
                deletion,
                noop_insertions[plus_index],
                insertion,
                minus_line,
                plus_line,
            );
            if minus_lines.len() == plus_lines.len()
                && distance <= max_line_distance_for_naively_paired_lines
                || distance <= max_line_distance
            {
                // minus_line and plus_line are inferred to be a homologous pair.

                // Emit as unpaired the plus lines already considered and rejected
                for plus_line in &plus_lines[plus_index..(plus_index + considered)] {
                    annotated_plus_lines.push(vec![(noop_insertions[plus_index], plus_line)]);
                    line_alignment.push((None, Some(plus_index)));
                    plus_index += 1;
                }
                annotated_minus_lines.push(annotated_minus_line);
                annotated_plus_lines.push(annotated_plus_line);
                line_alignment.push((Some(minus_index), Some(plus_index)));
                plus_index += 1;

                // Greedy: move on to the next minus line.
                continue 'minus_lines_loop;
            } else {
                considered += 1;
            }
        }
        // No homolog was found for minus i; emit as unpaired.
        annotated_minus_lines.push(vec![(noop_deletions[minus_index], minus_line)]);
        line_alignment.push((Some(minus_index), None));
    }
    // Emit any remaining plus lines
    for plus_line in &plus_lines[plus_index..] {
        if let Some(content) = get_contents_before_trailing_whitespace(plus_line) {
            annotated_plus_lines.push(vec![
                (noop_insertions[plus_index], content),
                (noop_insertions[plus_index], &plus_line[content.len()..]),
            ]);
        } else {
            annotated_plus_lines.push(vec![(noop_insertions[plus_index], plus_line)]);
        }
        line_alignment.push((None, Some(plus_index)));
        plus_index += 1;
    }

    (annotated_minus_lines, annotated_plus_lines, line_alignment)
}

// Return `None` if there is no trailing whitespace.
// Return `Some(content)` where content is trimmed if there was some trailing whitespace
fn get_contents_before_trailing_whitespace(line: &str) -> Option<&str> {
    let content = line.trim_end();
    // if line has a trailing newline, do not consider it as a 'trailing whitespace'
    if !content.is_empty() && content != line.trim_end_matches('\n') {
        Some(content)
    } else {
        None
    }
}

/// Split line into tokens for alignment. The alignment algorithm aligns sequences of substrings;
/// not individual characters.
fn tokenize<'a>(line: &'a str, regex: &Regex) -> Vec<&'a str> {
    // Starting with "", see comment in Alignment::new(). Historical note: Replacing the '+/-'
    // prefix with a space implicitly generated this.
    let mut tokens = vec![""];
    let mut offset = 0;
    for m in regex.find_iter(line) {
        if offset == 0 && m.start() > 0 {
            tokens.push("");
        }
        // Align separating text as multiple single-character tokens.
        for t in line[offset..m.start()].graphemes(true) {
            tokens.push(t);
        }
        tokens.push(&line[m.start()..m.end()]);
        offset = m.end();
    }
    if offset < line.len() {
        if offset == 0 {
            tokens.push("");
        }
        for t in line[offset..line.len()].graphemes(true) {
            tokens.push(t);
        }
    }
    tokens
}

/// Use alignment to "annotate" minus and plus lines. An "annotated" line is a sequence of
/// (a: Annotation, s: &str) pairs, where the &strs reference the memory
/// of the original line and their concatenation equals the line.
// This function doesn't return "coalesced" annotations: i.e. they're often are runs of consecutive
// occurrences of the same operation. Since it is returning &strs pointing into the memory of the
// original line, it's not possible to coalesce them in this function.
#[allow(clippy::type_complexity)]
fn annotate<'a, Annotation>(
    alignment: align::Alignment<'a>,
    noop_deletion: Annotation,
    deletion: Annotation,
    noop_insertion: Annotation,
    insertion: Annotation,
    minus_line: &'a str,
    plus_line: &'a str,
) -> (Vec<(Annotation, &'a str)>, Vec<(Annotation, &'a str)>, f64)
where
    Annotation: Copy + PartialEq + std::fmt::Debug,
{
    let mut annotated_minus_line = Vec::new();
    let mut annotated_plus_line = Vec::new();

    let (mut x_offset, mut y_offset) = (0, 0);
    let (mut minus_line_offset, mut plus_line_offset) = (0, 0);
    let (mut d_numer, mut d_denom) = (0, 0);

    // Note that the inputs to align::Alignment are not the original strings themselves, but
    // sequences of substrings derived from the tokenization process. We have just applied
    // run_length_encoding to "coalesce" runs of the same edit operation into a single
    // operation. We now need to form a &str, pointing into the memory of the original line,
    // identifying a "section" which is the concatenation of the substrings involved in this
    // coalesced operation. That's what the following closures do. Note that they must be called
    // once only since they advance offset pointers.
    let get_section = |n: usize,
                       line_offset: &mut usize,
                       substrings_offset: &mut usize,
                       substrings: &[&str],
                       line: &'a str| {
        let section_length = substrings[*substrings_offset..*substrings_offset + n]
            .iter()
            .fold(0, |n, s| n + s.len());
        let old_offset = *line_offset;
        *line_offset += section_length;
        *substrings_offset += n;
        &line[old_offset..*line_offset]
    };
    let mut minus_section = |n: usize, offset: &mut usize| {
        get_section(n, &mut minus_line_offset, offset, &alignment.x, minus_line)
    };
    let mut plus_section = |n: usize, offset: &mut usize| {
        get_section(n, &mut plus_line_offset, offset, &alignment.y, plus_line)
    };
    let distance_contribution = |section: &str| UnicodeWidthStr::width(section.trim());

    let (mut minus_op_prev, mut plus_op_prev) = (noop_deletion, noop_insertion);
    for (op, n) in alignment.coalesced_operations() {
        match op {
            align::Operation::Deletion => {
                let minus_section = minus_section(n, &mut x_offset);
                let n_d = distance_contribution(minus_section);
                d_denom += n_d;
                d_numer += n_d;
                annotated_minus_line.push((deletion, minus_section));
                minus_op_prev = deletion;
            }
            align::Operation::NoOp => {
                let minus_section = minus_section(n, &mut x_offset);
                let n_d = distance_contribution(minus_section);
                d_denom += 2 * n_d;
                let is_space = minus_section.trim().is_empty();
                let coalesce_space_with_previous = is_space
                    && ((minus_op_prev == deletion
                        && plus_op_prev == insertion
                        && (x_offset < alignment.x.len() - 1 || y_offset < alignment.y.len() - 1))
                        || (minus_op_prev == noop_deletion && plus_op_prev == noop_insertion));
                annotated_minus_line.push((
                    if coalesce_space_with_previous {
                        minus_op_prev
                    } else {
                        noop_deletion
                    },
                    minus_section,
                ));
                let op = if coalesce_space_with_previous {
                    plus_op_prev
                } else {
                    noop_insertion
                };
                let plus_section = plus_section(n, &mut y_offset);
                if let Some(non_whitespace) = get_contents_before_trailing_whitespace(plus_section)
                {
                    annotated_plus_line.push((op, non_whitespace));
                    annotated_plus_line.push((op, &plus_section[non_whitespace.len()..]));
                } else {
                    annotated_plus_line.push((op, plus_section));
                }
                minus_op_prev = noop_deletion;
                plus_op_prev = noop_insertion;
            }
            align::Operation::Insertion => {
                let plus_section = plus_section(n, &mut y_offset);
                let n_d = distance_contribution(plus_section);
                d_denom += n_d;
                d_numer += n_d;
                annotated_plus_line.push((insertion, plus_section));
                plus_op_prev = insertion;
            }
        }
    }
    (
        annotated_minus_line,
        annotated_plus_line,
        compute_distance(d_numer as f64, d_denom as f64),
    )
}

fn compute_distance(d_numer: f64, d_denom: f64) -> f64 {
    if d_denom > 0.0 {
        d_numer / d_denom
    } else {
        0.0
    }
}
