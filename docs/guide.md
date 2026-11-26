# Guide

The concepts an app meets when it uses `@duongtdn/agent-cockpit`. For the
exact names and types, read the [API reference](api.md).

**Status:** the cockpit is not built yet. Each section below is written when
the part it describes is built; until then it only says what it will cover.

## Jobs

What an app declares: a named piece of work for the agent, with its
arguments, its prompt and its folder.

## Units of work

What a job's run works on, named by a key, and how one conversation stays
with it.

## Sessions and their five states

The agent running for a unit of work, and what `starting`, `idle`, `busy`,
`waiting` and `ended` mean.

## Run, send and open

Starting or resuming a session with a job, sending it a prompt, and opening
it with none.

## Interrupt, end and remove

Stopping a turn, ending a session, and removing a unit of work.

## Asks

What the agent asks a person — a question, a plan, a permission, an input —
and how an app shows and answers it.

## The channel

The typed messages an app declares between its pages and the agent: notices
and requests.

## The activity stream

What a session did, as a stream an app can follow live and read back.

## The one-shot call

A single call to the model, outside any session.

## The terminal

The agent's real terminal, mounted in the app's page.

## Errors

Every failure the cockpit reports is a `CockpitError`: one class, with a
kebab-case `code` that tells the failures apart and decides the other fields
the error carries, and a `message` in English for logs and developers.
`isCockpitError(value, code?)` tells one from any other thrown value. The
server and the browser client use the same class, codes and fields. The codes
are listed in the [API reference](api.md#errors); nothing throws them yet.
