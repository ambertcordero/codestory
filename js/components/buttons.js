/* CodeStory - components/buttons.js
   Selection behaviour for reusable button groups: chapters, process steps,
   topic pills and the previous / next chapter navigation. */

const chapterItems = document.querySelectorAll('.chapter');
const processSteps = document.querySelectorAll('.process-step');
const topicPills = document.querySelectorAll('.topic-pill');
const navButtons = document.querySelectorAll('.nav-btn');

chapterItems.forEach((item) => {
  item.addEventListener('click', () => {
    chapterItems.forEach((button) => button.classList.remove('active'));
    item.classList.add('active');
  });
});

processSteps.forEach((step) => {
  step.addEventListener('click', () => {
    processSteps.forEach((button) => button.classList.remove('active'));
    step.classList.add('active');
  });
});

topicPills.forEach((pill) => {
  pill.addEventListener('click', () => {
    topicPills.forEach((button) => button.classList.remove('active'));
    pill.classList.add('active');
  });
});

navButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const activeIndex = [...chapterItems].findIndex((item) => item.classList.contains('active'));
    if (!button.classList.contains('next') && activeIndex > 0) {
      chapterItems[activeIndex].classList.remove('active');
      chapterItems[activeIndex - 1].classList.add('active');
    }
    if (button.classList.contains('next') && activeIndex < chapterItems.length - 1) {
      chapterItems[activeIndex].classList.remove('active');
      chapterItems[activeIndex + 1].classList.add('active');
    }
  });
});
