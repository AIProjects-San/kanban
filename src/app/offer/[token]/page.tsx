import type { Metadata } from "next";
import { getOfferByToken } from "@/server-actions/hiring-offers";
import { OfferSignView, OfferLinkInvalid, type PublicOfferT } from "@/components/offer/offer-sign-view";

// Recruitment R6 — the PUBLIC offer signing route. No session: the 256-bit
// single-use token in the URL is the authorization (see
// docs/RECRUITMENT_MODULE_PLAN.md §5 R6). Per-request rendering — the token's
// state (SENT + unexpired) decides what the visitor may see, so this page can
// never be cached or statically generated.
export const dynamic = "force-dynamic";

// Signing links are private personal URLs — keep them out of crawlers.
export const metadata: Metadata = {
  title: "Your offer — sign online",
  robots: { index: false, follow: false },
};

export default async function OfferPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const res = await getOfferByToken(token);

  if (!res.ok) {
    // Friendly, non-enumerating error states ("not valid" / "expired") — no
    // internal ids, no retry affordances.
    return <OfferLinkInvalid message={res.error} />;
  }

  const d = res.data;
  const offer: PublicOfferT = {
    token,
    offerId: d.offerId,
    candidateName: d.candidateName,
    position: d.position,
    workspaceName: d.workspaceName,
    templateLabel: d.templateLabel,
    letterText: d.letterText,
    components: d.components,
    benefits: d.benefits,
    totals: d.totals,
    expiresAt: d.expiresAt,
  };
  // A consumed token (signed / declined) renders its recorded outcome — the
  // signer revisiting their link sees their confirmation, not a dead end.
  return (
    <OfferSignView
      offer={offer}
      initialOutcome={d.state === "SIGNED" ? "signed" : d.state === "DECLINED" ? "declined" : null}
      signedAt={d.signedAt}
      signedName={d.signedName}
    />
  );
}
