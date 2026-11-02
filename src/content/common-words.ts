/**
 * The language of a few words the detector can't judge: "Learn more" on a Spanish page, "Merci"
 * between English paragraphs.
 *
 * Passages this short never reach the browser's detector (it is unreliable on them), and used to
 * take the language of the passage before, so a site's English "Learn more" under a Spanish
 * paragraph was read in Spanish. Each language here has a short list of its commonest words and of
 * the words websites put on buttons and links. A short passage whose every word is in exactly one
 * language's list is in that language; a word shared by two ("no", "a", "in") decides nothing.
 */

const WORDS: Readonly<Record<string, string>> = {
  en: `the a an and or but of to in on at by for with from about as is are was were be been it this that these those
    you your we our they their he she his her i my me not no yes all more most less other new next previous back
    learn read see view show hide open close more sign log in out up down here there now today home menu search
    share print download subscribe follow contact help privacy terms cookies settings account login logout register
    continue skip accept reject cancel ok submit send reply comment comments like save saved edit delete page
    top bottom article articles story stories news latest related popular trending video videos photo photos
    please thank thanks hello hi goodbye bye welcome what when where who why how which can will would should`,
  es: `el la los las un una unos unas y o pero de del al en con por para sin sobre es son era fue ser este esta estos
    estas ese esa que se su sus tu tus nuestro mi mis yo nosotros ellos él ella no sí todo todos más menos otro
    nuevo siguiente anterior volver leer ver mostrar ocultar abrir cerrar iniciar sesión entrar salir inicio menú
    buscar compartir imprimir descargar suscribirse seguir contacto ayuda privacidad términos ajustes cuenta
    registrarse continuar aceptar rechazar cancelar enviar responder comentario comentarios guardar editar
    borrar página noticias artículo artículos relacionados gracias hola adiós bienvenido qué cuándo dónde quién
    por qué cómo cuál puede saber también muy aquí ahora hoy`,
  fr: `le la les un une des et ou mais de du au aux en avec par pour sans sur est sont était été être ce cette ces
    que qui se son sa ses ton ta tes notre nos mon ma mes je nous vous ils elles il elle ne pas oui tout tous plus
    moins autre nouveau suivant précédent retour lire voir afficher masquer ouvrir fermer connexion déconnexion
    accueil menu rechercher partager imprimer télécharger abonner suivre contact aide confidentialité conditions
    paramètres compte inscription continuer accepter refuser annuler envoyer répondre commentaire commentaires
    enregistrer modifier supprimer page actualités article articles merci bonjour bonsoir salut au revoir
    bienvenue quoi quand où pourquoi comment quel quelle aussi très ici maintenant aujourd'hui savoir`,
  de: `der die das ein eine einen dem den des und oder aber von zu im in am an auf mit bei für aus über ist sind war
    waren sein dieser diese dieses dass sich sein ihr ihre unser mein meine ich wir sie er es nicht nein ja alle
    mehr weniger andere neu weiter zurück lesen ansehen anzeigen ausblenden öffnen schließen anmelden abmelden
    startseite menü suchen teilen drucken herunterladen abonnieren folgen kontakt hilfe datenschutz bedingungen
    einstellungen konto registrieren fortfahren akzeptieren ablehnen abbrechen senden antworten kommentar
    kommentare speichern bearbeiten löschen seite nachrichten artikel danke hallo tschüss willkommen was wann wo
    wer warum wie welche auch sehr hier jetzt heute erfahren`,
  it: `il lo la i gli le un uno una e o ma di del della dei al alla in con per su da è sono era stato essere questo
    questa questi quelle che si suo sua suoi tuo nostro mio io noi voi loro lui lei non sì tutto tutti più meno
    altro nuovo successivo precedente indietro leggi vedi mostra nascondi apri chiudi accedi esci home cerca
    condividi stampa scarica iscriviti segui contatti aiuto privacy termini impostazioni account registrati
    continua accetta rifiuta annulla invia rispondi commento commenti salva modifica elimina pagina notizie
    articolo articoli grazie ciao arrivederci benvenuto cosa quando dove chi perché come quale anche molto qui
    ora oggi scopri`,
  pt: `o a os as um uma uns umas e ou mas de do da dos das no na nos nas em com por para sem sobre é são era foi ser
    este esta estes estas esse essa que se seu sua seus tua nosso meu minha eu nós eles elas ele ela não sim todo
    todos mais menos outro novo próximo anterior voltar ler ver mostrar ocultar abrir fechar entrar sair início
    pesquisar compartilhar imprimir baixar inscrever seguir contato ajuda privacidade termos configurações conta
    cadastrar continuar aceitar recusar cancelar enviar responder comentário comentários salvar editar excluir
    página notícias artigo artigos obrigado obrigada olá tchau bem-vindo quando onde quem porque como qual também
    muito aqui agora hoje saiba`,
  nl: `de het een en of maar van te in op aan bij voor met uit over is zijn was waren deze dit dat die zich zijn haar
    onze mijn ik wij jullie zij hij niet nee ja alle meer minder ander nieuw volgende vorige terug lees lezen
    bekijk tonen verbergen openen sluiten inloggen uitloggen menu zoeken delen afdrukken downloaden abonneren
    volgen contact hulp privacy voorwaarden instellingen account registreren doorgaan accepteren weigeren
    annuleren verzenden reageren reactie reacties opslaan bewerken verwijderen pagina nieuws artikel artikelen
    bedankt dank hallo doei welkom wat wanneer waar wie waarom hoe welke ook heel hier nu vandaag`,
};

const LISTS = new Map(Object.entries(WORDS).map(([lang, text]) => [lang, new Set(text.split(/\s+/).filter(Boolean))]));

/** The one language whose common words include every word of `text`, or '' when none or several. */
export function commonWordsLanguage(text: string): string {
  const words = text.toLocaleLowerCase().match(/[\p{L}'-]+/gu) ?? [];
  if (words.length === 0) return '';
  const fits = [...LISTS].filter(([, list]) => words.every((w) => list.has(w))).map(([lang]) => lang);
  return fits.length === 1 ? fits[0]! : '';
}
