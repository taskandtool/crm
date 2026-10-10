import { test } from "node:test";
import assert from "node:assert/strict";
import { FormView } from "../render";
import type { Form } from "../fields";

const form: Form = {
  key: "contact",
  title: "Contact",
  notify_emails: [],
  redirect_to: null,
  success_message: null,
  submit_label: null,
  active: true,
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "email", required: true, help: "We reply here." },
    { name: "phone", label: "Phone", type: "tel" },
    { name: "note", label: `<script>alert("label")</script>`, type: "textarea" },
    { name: "size", label: "Size", type: "select", options: ["Small", `"><b>Large`] },
    { name: "rooms", label: "Rooms", type: "checkbox", options: ["Kitchen", "Bath"] },
    { name: "news", label: "Send me news", type: "consent" },
  ],
};

const html = (props: Partial<Parameters<typeof FormView>[0]> = {}) => String(FormView({ form, stamp: "123", page: "/contact", ...props }));

test("labels, autocomplete, inputmode and the spam fields are there with no JavaScript", () => {
  const h = html();
  assert.match(h, /<form method="post" action="\/forms\/contact"/);
  assert.match(h, /<label for="f-contact-name"/);
  assert.match(h, /id="f-contact-name" name="name" required=""/);
  assert.match(h, /autocomplete="name"/);
  assert.match(h, /type="email" inputmode="email" autocomplete="email"/);
  assert.match(h, /type="tel" inputmode="tel" autocomplete="tel"/);
  assert.match(h, /aria-describedby="f-contact-email-help"/);
  assert.match(h, /<input name="company_website" type="text" tabindex="-1" autocomplete="off" value=""/);
  assert.match(h, /aria-hidden="true"/);
  assert.match(h, /<input type="hidden" name="_started" value="123"/);
  assert.match(h, /<input type="hidden" name="_page" value="\/contact"/);
  assert.doesNotMatch(h, /aria-invalid/);
});

test("hostile labels, options and values are escaped", () => {
  const h = html({ values: { name: `"><img src=x onerror=alert(1)>`, note: "</textarea><script>x()</script>" } });
  assert.doesNotMatch(h, /<script>/);
  assert.doesNotMatch(h, /<img/);
  assert.doesNotMatch(h, /<b>Large/);
  assert.match(h, /&lt;script&gt;alert/);
});

test("after an error each answer comes back and each message is wired to its field", () => {
  const h = html({
    values: { name: "", email: "ann@example", size: "Small", rooms: ["Bath"], news: "yes" },
    errors: { name: "Please fill this in.", email: "Enter an email address like name@example.com." },
  });
  assert.match(h, /role="alert"/);
  assert.match(h, /href="#f-contact-email"/);
  assert.match(h, /id="f-contact-email"[^>]*aria-invalid="true" aria-describedby="f-contact-email-help f-contact-email-error"/);
  assert.match(h, /<p id="f-contact-email-error"[^>]*>Enter an email address/);
  assert.match(h, /value="ann@example"/);
  assert.match(h, /<option value="Small" selected="">/);
  assert.match(h, /value="Bath" id="f-contact-rooms-1" checked=""/);
  assert.doesNotMatch(h, /value="Kitchen" id="f-contact-rooms-0" checked/);
  assert.match(h, /name="news" value="yes" class="mt-1" checked=""/);
});

test("a photo field picks a file and posts only the path its upload got", () => {
  const h = String(FormView({ form: { ...form, fields: [{ name: "photo", label: "Photo", type: "photo" }] }, stamp: "1", values: { photo: "/_files/x" } }));
  assert.match(h, /<input id="f-contact-photo" type="file" accept="image\/\*"/);
  assert.doesNotMatch(h, /type="file"[^>]*name=/);
  assert.match(h, /<input type="hidden" name="photo" value="\/_files\/x"/);
  assert.match(h, /Photo attached\./);
  assert.match(h, /fetch\("\/_files"/);
});
