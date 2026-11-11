// Sentence themes, grouped for the picker on the Practice screen.
export const THEMES = [
  { group: "Everyday life", items: ["Greetings and introductions", "Family", "Friends and relationships", "Home and housework", "Daily routine", "Time and dates", "Weather and seasons", "Describing people", "Feelings and opinions"] },
  { group: "Food and drink", items: ["Eating out", "Cooking and groceries", "Drinks and cafés"] },
  { group: "Out and about", items: ["Shopping", "Money and prices", "Going out", "Getting around town", "Asking for directions", "Travel and hotels", "City and countryside"] },
  { group: "Work and study", items: ["School and studying", "Work and the office", "Learning Chinese", "Phones and technology", "Phone calls and messages"] },
  { group: "Health and body", items: ["Health and the doctor", "Sports and exercise", "Clothes and appearance"] },
  { group: "Free time", items: ["Hobbies", "Films, music and books", "Holidays and festivals", "Nature and animals"] },
  { group: "Getting things done", items: ["Plans and invitations", "Asking for help", "Past experiences", "Hopes and future plans"] },
];
export const ALL_THEMES = THEMES.flatMap((g) => g.items);
