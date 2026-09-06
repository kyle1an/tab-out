# ADR 0025: Accept Ordinary Remote Deactivation Repaint

- Status: Accepted
- Date: 2026-09-04

## Context

macOS has one globally active application. Directing keyboard input to an exact
Chrome window therefore deactivates an unchanged frontmost application on every
other display, and that application may repaint its active appearance. Treating
every remote pixel change as a shortcut failure would make Target Focus
unavailable for those applications, while detecting pixels during normal use
would require unnecessary capture of non-target displays.

## Decision

- Remote Display Preservation allows the ordinary active-to-inactive repaint of
  an unchanged frontmost remote window when Chrome becomes globally active.
- A blank or bright transitional frame, Desktop exposure, unrelated content,
  Remote Raise, or Remote Focus remains a violation.
- Live qualification compares a frame recording of the shortcut with ordinary
  pointer-display Chrome activation in equivalent state. Only transition frames
  added by the shortcut fail the visual oracle; Tab Out does not capture
  non-target displays at runtime.

## Consequences

Target Focus remains available without hiding or replaying remote content. An
ordinary inactive tint or redraw may remain visible and is not reported as a
Tab Out defect. Automated focus, Space, and z-order checks still require the
reference-delta visual run after macOS updates or private-activation changes.
